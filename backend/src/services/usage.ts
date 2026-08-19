/**
 * LLM usage and cost meter.
 *
 * Every model call the platform makes is recorded here — provider, model, which
 * surface asked, tokens in and out, latency — so /settings can show what the
 * platform actually costs to run. Without this the question "what are we
 * spending?" can only be answered from the providers' own dashboards, which
 * cannot tell you that vision calls from the Comer AI dock are the expensive
 * part.
 *
 * Recording is best-effort and never allowed to break a request: a failure to
 * write the ledger must not cost a director their answer.
 *
 * PRICE ACCURACY. The rates below are defaults, not quotes. Provider pricing
 * changes and per-account terms differ, so every rate is overridable by env and
 * the UI shows which rates produced the numbers. Treat the figures as an
 * estimate to size the bill, not as an invoice.
 *
 * DURABILITY. Records append to a JSONL ledger and aggregate in memory. On a
 * host with an ephemeral filesystem (Render's default) the ledger is lost on
 * redeploy, so the report states the window it actually covers rather than
 * implying all-time totals. A persistent disk or a real table removes that
 * caveat; the shape here is deliberately one row per call so it can be moved
 * into Postgres without changing callers.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Which surface made the call. Cost questions are almost always "which
 *  feature is expensive?", so this is the dimension that matters most. */
export type UsageRoute =
  | "brain-chat"      // knowledge Q&A (home chat, dock, eval lab)
  | "assist-vision"   // component recognition from an attached photo
  | "assist-text"     // component question, no photo
  | "line-ask"        // natural-language MES question, station snapshot only
  | "mes-ask"         // natural-language SQL against the MES (2 calls: plan + answer)
  | "kb-pov"          // POV recording analysis on ingest
  | "glasses-query"   // the Rokid APK /query endpoint (device, not platform)
  | "eval"            // eval lab runs
  | "spec"            // spec/taxonomy helpers
  | "other";

export interface UsageRecord {
  ts: number;
  provider: "anthropic" | "google";
  model: string;
  route: UsageRoute;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Stubbed calls cost nothing — they never left the process. */
  stubbed: boolean;
}

/* ── Rates ────────────────────────────────────────────────────────────────── */

interface Rate {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

/** Parse `MODEL:IN_RATE:OUT_RATE,…` from LLM_RATES_USD_PER_MTOK. */
function parseRateOverrides(): Record<string, Rate> {
  const raw = (process.env.LLM_RATES_USD_PER_MTOK ?? "").trim();
  if (!raw) return {};
  const out: Record<string, Rate> = {};
  for (const entry of raw.split(",")) {
    const [model, i, o] = entry.split(":").map((s) => s.trim());
    const ri = Number(i);
    const ro = Number(o);
    if (model && Number.isFinite(ri) && Number.isFinite(ro)) {
      out[model.toLowerCase()] = { in: ri, out: ro };
    }
  }
  return out;
}

/** Defaults by model family — see the PRICE ACCURACY note above. Matched as a
 *  prefix so minor version bumps do not silently fall back to zero. */
const DEFAULT_RATES: Array<{ prefix: string; rate: Rate }> = [
  { prefix: "claude-opus", rate: { in: 15, out: 75 } },
  { prefix: "claude-sonnet", rate: { in: 3, out: 15 } },
  { prefix: "claude-haiku", rate: { in: 0.8, out: 4 } },
  { prefix: "gemini-3.5-flash", rate: { in: 0.3, out: 2.5 } },
  { prefix: "gemini-2.5-flash", rate: { in: 0.3, out: 2.5 } },
  { prefix: "gemini", rate: { in: 0.3, out: 2.5 } },
];

const OVERRIDES = parseRateOverrides();

export function rateFor(model: string): Rate | null {
  const m = model.toLowerCase();
  if (OVERRIDES[m]) return OVERRIDES[m];
  const hit = DEFAULT_RATES.find((r) => m.startsWith(r.prefix));
  return hit ? hit.rate : null;
}

function costOf(r: UsageRecord): number {
  if (r.stubbed) return 0;
  const rate = rateFor(r.model);
  if (!rate) return 0;
  return (r.inputTokens / 1e6) * rate.in + (r.outputTokens / 1e6) * rate.out;
}

/* ── Ledger ───────────────────────────────────────────────────────────────── */

const LEDGER =
  (process.env.USAGE_LEDGER_PATH ?? "").trim() ||
  join(process.cwd(), ".usage", "usage.jsonl");

/** Recent calls, newest last. Bounded so a long-running process cannot grow
 *  without limit; the aggregates below are what the report actually reads. */
const RECENT_LIMIT = 500;
const recent: UsageRecord[] = [];
let totalRecorded = 0;
/** Oldest record we can account for — drives the "covers" line in the UI. */
let since: number | null = null;

interface Bucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyTotalMs: number;
  stubbedCalls: number;
}

const byDay = new Map<string, Bucket>();
const byRoute = new Map<string, Bucket>();
const byModel = new Map<string, Bucket>();

const emptyBucket = (): Bucket => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyTotalMs: 0,
  stubbedCalls: 0,
});

function add(map: Map<string, Bucket>, key: string, r: UsageRecord, cost: number) {
  const b = map.get(key) ?? emptyBucket();
  b.calls += 1;
  b.inputTokens += r.inputTokens;
  b.outputTokens += r.outputTokens;
  b.costUsd += cost;
  b.latencyTotalMs += r.latencyMs;
  if (r.stubbed) b.stubbedCalls += 1;
  map.set(key, b);
}

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function ingest(r: UsageRecord) {
  const cost = costOf(r);
  totalRecorded += 1;
  if (since === null || r.ts < since) since = r.ts;
  recent.push(r);
  if (recent.length > RECENT_LIMIT) recent.shift();
  add(byDay, dayKey(r.ts), r, cost);
  add(byRoute, r.route, r, cost);
  add(byModel, r.stubbed ? `${r.model} (stub)` : r.model, r, cost);
}

/** Record a model call. Never throws — callers are on the request path. */
export function recordUsage(r: Omit<UsageRecord, "ts"> & { ts?: number }): void {
  try {
    const rec: UsageRecord = { ts: r.ts ?? Date.now(), ...r } as UsageRecord;
    ingest(rec);
    // Stubs are not billable and would drown the ledger during local dev.
    if (rec.stubbed) return;
    void appendLedger(rec);
  } catch {
    /* metering must never break a response */
  }
}

let ledgerBroken = false;
async function appendLedger(rec: UsageRecord): Promise<void> {
  if (ledgerBroken) return;
  try {
    await mkdir(dirname(LEDGER), { recursive: true });
    await appendFile(LEDGER, JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    // A read-only or full filesystem should degrade to in-memory metering
    // rather than logging on every single call.
    ledgerBroken = true;
    // eslint-disable-next-line no-console
    console.warn(`[usage] ledger disabled: ${(e as Error).message}`);
  }
}

/** Replay the ledger at boot so a restart does not appear to zero the bill. */
export async function loadLedger(): Promise<void> {
  try {
    const raw = await readFile(LEDGER, "utf8");
    let n = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as UsageRecord;
        if (typeof rec.ts === "number" && typeof rec.model === "string") {
          ingest(rec);
          n += 1;
        }
      } catch {
        /* skip a torn line rather than refusing to start */
      }
    }
    if (n) {
      // eslint-disable-next-line no-console
      console.log(`[usage] replayed ${n} billable calls from ${LEDGER}`);
    }
  } catch {
    /* no ledger yet — first run */
  }
}

/* ── Report ───────────────────────────────────────────────────────────────── */

const round = (n: number, d = 4) => Number(n.toFixed(d));

function serialize(map: Map<string, Bucket>) {
  return [...map.entries()]
    .map(([key, b]) => ({
      key,
      calls: b.calls,
      stubbedCalls: b.stubbedCalls,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      costUsd: round(b.costUsd),
      avgLatencyMs: b.calls ? Math.round(b.latencyTotalMs / b.calls) : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

export function usageSummary() {
  let calls = 0;
  let billable = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const b of byRoute.values()) {
    calls += b.calls;
    billable += b.calls - b.stubbedCalls;
    inputTokens += b.inputTokens;
    outputTokens += b.outputTokens;
    costUsd += b.costUsd;
  }

  const days = serialize(byDay).sort((a, b) => a.key.localeCompare(b.key));
  // Projection uses billable days only; averaging in days the service was idle
  // would understate a live line's run-rate.
  const billableDays = days.filter((d) => d.costUsd > 0).length;
  const avgPerDay = billableDays ? costUsd / billableDays : 0;

  return {
    ok: true as const,
    totals: {
      calls,
      billableCalls: billable,
      stubbedCalls: calls - billable,
      inputTokens,
      outputTokens,
      costUsd: round(costUsd),
      avgCostPerBillableCallUsd: billable ? round(costUsd / billable, 6) : 0,
    },
    projection: {
      billableDays,
      avgCostPerDayUsd: round(avgPerDay),
      projectedMonthlyUsd: round(avgPerDay * 30),
    },
    byDay: days,
    byRoute: serialize(byRoute),
    byModel: serialize(byModel),
    /** Rates that produced these numbers, so the figures are auditable. */
    rates: {
      unit: "USD per 1M tokens",
      overridesFrom: "LLM_RATES_USD_PER_MTOK",
      applied: [...byModel.keys()]
        .map((k) => k.replace(/ \(stub\)$/, ""))
        .filter((m, i, a) => a.indexOf(m) === i)
        .map((model) => ({ model, rate: rateFor(model) })),
    },
    ledger: {
      path: LEDGER,
      writable: !ledgerBroken,
      recordsAccounted: totalRecorded,
      /** Null until the first call — the UI says "no calls yet" rather than
       *  showing an epoch date. */
      since: since ? new Date(since).toISOString() : null,
      note: ledgerBroken
        ? "Ledger not writable — totals cover this process only."
        : "Totals cover the ledger on disk; an ephemeral filesystem resets it on redeploy.",
    },
  };
}
