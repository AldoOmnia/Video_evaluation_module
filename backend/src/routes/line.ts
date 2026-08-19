/**
 * /api/line — live-line status + glasses warnings report for the platform home.
 *
 * Data source strategy (in order):
 *   1. LINE_BRIDGE_URL — the on-site comer-rokid-demo backend exposing the
 *      read-only UNICOMM/SSL04_FARGO façade (`/v1/unicomm/*`). When Comer's
 *      MES connector is published for this platform, set LINE_BRIDGE_URL
 *      (+ LINE_BRIDGE_API_KEY) and these endpoints go live with zero UI work.
 *   2. Stub snapshot — connector-shaped demo data so the home page renders
 *      the exact layout the live wiring will fill in.
 *
 * Payload shapes mirror the UNICOMM connector's `fetchWorkstationSnapshot()`
 * on the connectors/mssql-unicomm-database branch of comer-rokid-demo.
 */
import { Router } from "express";
import { z } from "zod";
import { llmCall } from "../services/anthropic.js";
import { askMes } from "../services/mesAsk.js";
import { fetchStationSnapshot, mesConfig, mesConfigured } from "../services/mesSql.js";

export const lineRouter = Router();

const BRIDGE_URL = process.env.LINE_BRIDGE_URL?.trim() || null;
const BRIDGE_KEY = process.env.LINE_BRIDGE_API_KEY?.trim() || null;

/** Steady-state budget. The first call after boot gets more: the connector has
 *  to open its MSSQL pool, which routinely takes longer than a warm query, and
 *  timing that out would drop us to demo data while the line is in fact fine. */
const BRIDGE_TIMEOUT_MS = 4000;
const BRIDGE_COLD_TIMEOUT_MS = 12_000;

/** Why the last bridge read did not produce live data. Surfaced to the UI so a
 *  transient failure reads as "reconnecting" rather than "no bridge here". */
type BridgeFault = "unreachable" | "http" | "timeout" | "malformed";

let bridgeWarm = false;
let lastFault: BridgeFault | null = null;
/** Last direct-SQL failure, so the status card can distinguish "no database
 *  configured" from "the database is configured and refused us". */
let sqlFault: string | null = null;

async function bridgeGet(path: string): Promise<unknown | null> {
  if (!BRIDGE_URL) return null;
  const ctrl = new AbortController();
  const budget = bridgeWarm ? BRIDGE_TIMEOUT_MS : BRIDGE_COLD_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const res = await fetch(`${BRIDGE_URL.replace(/\/$/, "")}${path}`, {
      signal: ctrl.signal,
      headers: BRIDGE_KEY ? { "x-api-key": BRIDGE_KEY } : {},
    });
    if (!res.ok) {
      lastFault = "http";
      // eslint-disable-next-line no-console
      console.warn(`[line] bridge ${path} → HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    bridgeWarm = true;
    lastFault = null;
    return body;
  } catch (e) {
    lastFault =
      e instanceof Error && e.name === "AbortError"
        ? "timeout"
        : e instanceof SyntaxError
          ? "malformed"
          : "unreachable";
    // A bridge that goes quiet mid-demo must be diagnosable from the logs.
    // eslint-disable-next-line no-console
    console.warn(`[line] bridge ${path} → ${lastFault} (budget ${budget}ms)`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Connector-shaped demo snapshot (SSL04_FARGO field names). */
function stubWorkstationSnapshot() {
  return {
    timestamp: Date.now(),
    station_id: "PG-04",
    station_number: 100,
    test_number: "ST.100",
    session_active: true,
    current_step_code: "S09",
    step_index: 9,
    total_steps: 12,
    current_step_title: "Torque pinion nut — 3-pass sequence",
    current_phase_result: null,
    last_phase_at: new Date(Date.now() - 42_000).toISOString(),
    technician_id: "1042",
    technician_name: "M. Rossi",
    technician_dept: "Assembly",
    serial_number: "CMR-7741-0093",
    model: "P-750 pinion guide",
    measurements: [
      {
        label: "Pinion nut torque — pass 2",
        value: 82.4,
        min: 78,
        max: 86,
        unit: "Nm",
        verdict: "OK",
        in_range: true,
      },
    ],
  };
}

interface LineStatus {
  ok: true;
  mode: "live" | "stub";
  connected: boolean;
  bridge: string | null;
  /** Which path produced this: direct SQL, the HTTP bridge, or demo data. */
  source?: "sql" | "bridge" | "stub";
  mes: Record<string, unknown> | null;
  snapshot: Record<string, unknown>;
  /** "none" when no bridge is configured at all, "reconnecting" when one is
   *  configured but the last read failed — very different situations for
   *  someone watching the card. */
  degraded?: "none" | "reconnecting";
  fault?: BridgeFault | null;
  detail?: string;
  /** Age of the underlying bridge read; 0 on a fresh fetch. */
  cachedForMs?: number;
}

/**
 * Resolve the current line status once, so /status and /ask always agree on
 * what the line looks like (live bridge when configured, demo snapshot else).
 */
async function fetchLineStatus(): Promise<LineStatus> {
  // Direct SQL first: it is the shortest path to the truth and needs no second
  // repo, branch or process. The bridge stays as a fallback for deployments that
  // only have HTTP reach to the plant.
  if (mesConfigured()) {
    try {
      const snapshot = await fetchStationSnapshot();
      if (snapshot) {
        const c = mesConfig();
        return {
          ok: true,
          mode: "live",
          connected: true,
          bridge: null,
          source: "sql",
          mes: {
            host: c.host,
            port: c.port,
            database: c.database,
            station_number: c.stationNumber,
            test_number: c.testNumber,
            readonly: true,
          },
          snapshot: snapshot as unknown as Record<string, unknown>,
        };
      }
    } catch (e) {
      // Fall through to the bridge/stub path, but say why in the logs — a silent
      // downgrade to demo data is the hardest failure to diagnose mid-demo.
      // eslint-disable-next-line no-console
      console.warn(
        `[line] direct SQL failed, falling back: ${e instanceof Error ? e.message : String(e)}`,
      );
      sqlFault = e instanceof Error ? e.message : String(e);
    }
  }

  const [health, workstation] = await Promise.all([
    bridgeGet("/v1/unicomm/health"),
    bridgeGet("/v1/unicomm/workstation"),
  ]);

  if (workstation) {
    return {
      ok: true,
      mode: "live",
      connected: true,
      bridge: BRIDGE_URL,
      source: "bridge",
      mes: ((health as Record<string, unknown>)?.config as Record<string, unknown>) ?? null,
      snapshot: workstation as Record<string, unknown>,
    };
  }

  return {
    ok: true,
    mode: "stub",
    connected: false,
    bridge: BRIDGE_URL,
    source: "stub",
    degraded: BRIDGE_URL || mesConfigured() ? "reconnecting" : "none",
    fault: BRIDGE_URL ? lastFault : null,
    detail: mesConfigured()
      ? `MES database unreachable (${sqlFault ?? "unknown error"}) — showing demo snapshot`
      : BRIDGE_URL
        ? `line bridge ${lastFault ?? "unavailable"} — showing demo snapshot`
        : "no MES database configured (MES_MSSQL_*) — showing demo snapshot",
    mes: {
      host: "WARKFSQL002",
      database: "SSL04_FARGO",
      station_number: 100,
      readonly: true,
    },
    snapshot: stubWorkstationSnapshot() as Record<string, unknown>,
  };
}

/**
 * Short-lived cache in front of the bridge.
 *
 * The home card polls every 30 s *per open tab* and each poll is two bridge
 * calls, while the connector behind it is polling a production MSSQL box. With
 * a room full of tabs open that load multiplies onto the plant database for no
 * benefit — nothing on the line changes meaningfully inside three seconds.
 * One in-flight promise is shared by all concurrent callers.
 */
const STATUS_TTL_MS = 3000;
let statusCache: { at: number; value: LineStatus } | null = null;
let statusInFlight: Promise<LineStatus> | null = null;

async function resolveLineStatus(): Promise<LineStatus> {
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
    return { ...statusCache.value, cachedForMs: now - statusCache.at };
  }
  if (!statusInFlight) {
    statusInFlight = fetchLineStatus()
      .then((value) => {
        statusCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        statusInFlight = null;
      });
  }
  const value = await statusInFlight;
  return { ...value, cachedForMs: 0 };
}

lineRouter.get("/status", async (_req, res) => {
  res.json(await resolveLineStatus());
});

/**
 * Glasses warnings report — per worker/device: warnings fired, mistakes
 * avoided (worker corrected after the warning), captured POV frames, and an
 * avoided-rework saving estimate.
 *
 * Live path (later): aggregate the APK bridge's warning events + captured
 * frames posted back from the glasses. Until then: demo rows using real
 * error taxonomy codes and the repo's POV imagery.
 */
const AVG_REWORK_COST_EUR = 140; // demo estimate: avg rework labor+parts per caught mistake

async function resolveLineReport() {
  const live = await bridgeGet("/v1/line/report"); // future on-site aggregation
  if (live) {
    return { mode: "live", ...(live as Record<string, unknown>) };
  }

  const workers = [
    {
      workerId: "1042",
      workerName: "M. Rossi",
      device: "Rokid glasses · unit 3",
      warningsFired: 14,
      avoided: 11,
      missed: 3,
      topError: "INCOMPLETE · torque sequence cut short",
      frames: [
        { src: "/lab/assets/phase8_frame.jpg", label: "S09 · single-pass torque", code: "INCOMPLETE" },
        { src: "/lab/assets/worker_pov.jpg", label: "S07 · wrong shim SKU", code: "SUBSTITUTION" },
      ],
    },
    {
      workerId: "1087",
      workerName: "L. Bianchi",
      device: "Rokid glasses · unit 1",
      warningsFired: 8,
      avoided: 7,
      missed: 1,
      topError: "SUBSTITUTION · component mismatch",
      frames: [
        // Deployable web-sized crop — the full station panorama
        // (pinion_guide_station.jpg) is gitignored (~7 MB) so it 404s on Render.
        { src: "/lab/assets/report-orientation.jpg", label: "S04 · cup flipped at load", code: "ORIENTATION" },
      ],
    },
    {
      workerId: "1105",
      workerName: "S. Ferrari",
      device: "Rokid glasses · unit 2",
      warningsFired: 5,
      avoided: 5,
      missed: 0,
      topError: "OUT_OF_SPEC · press depth out of range",
      frames: [
        { src: "/lab/assets/phase8_frame.jpg", label: "S11 · press depth check", code: "OUT_OF_SPEC" },
      ],
    },
  ];

  const totalFired = workers.reduce((s, w) => s + w.warningsFired, 0);
  const totalAvoided = workers.reduce((s, w) => s + w.avoided, 0);

  return {
    mode: "stub",
    detail: "demo report — live glasses warning feed not yet published to this platform",
    period: "last 7 days",
    generatedAt: new Date().toISOString(),
    avgReworkCostEur: AVG_REWORK_COST_EUR,
    totals: {
      warningsFired: totalFired,
      avoided: totalAvoided,
      missed: totalFired - totalAvoided,
      estimatedSavingsEur: totalAvoided * AVG_REWORK_COST_EUR,
    },
    workers,
  };
}

lineRouter.get("/report", async (_req, res) => {
  res.json(await resolveLineReport());
});

/* ── Natural-language line questions ─────────────────────────────────────
 *
 * POST /api/line/ask — the plant-director path: a free-text question in
 * English or Italian, answered ONLY from what the MES connector returned.
 *
 * This is the platform side of the curated-tool contract: the connector (or
 * the demo snapshot standing in for it) is the single source of truth, and
 * the model is allowed to phrase it — never to invent a field. Anything the
 * snapshot doesn't carry comes back as an explicit "not in this snapshot"
 * so a director never mistakes a guess for a reading off the line.
 */
const AskSchema = z.object({
  query: z.string().min(1).max(500),
  lang: z.enum(["en", "it"]).optional(),
});

/** Glasses-warning questions need the report, not the MES.
 *
 *  Phrase-based on purpose. This used to match a bare "error" or "defect",
 *  which sent genuine quality questions ("how many errors at ST100 today")
 *  to the glasses demo stub instead of the database that actually records
 *  them. The report only owns questions about what the glasses caught. */
const WARNING_RE =
  /(warnings?\s+report|glasses\s+report|glasses\s+warnings?|smart\s+glasses|\bocchiali\b|report\s+(?:degli?\s+)?avvisi|avvisi\s+occhiali|\bsavings?\b|risparmi\w*|\brework\b|rilavorazion\w*|(?:mistakes?|errors?|rework)\s+avoided|errori\s+evitati|avoided\s+(?:mistakes?|errors?|rework))/i;

/** The model occasionally markdown-escapes MES identifiers (SSL04\_FARGO) or
 *  bolds a value even when asked for plain text. Strip that before it reaches
 *  a director's screen. */
function plainify(s: string): string {
  return s
    .replace(/\\([_*`[\]()#+\-.!])/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?]|$)/g, "$1$2")
    .trim();
}

/* ── Plant-local timestamps ───────────────────────────────────────────────
 *
 * SSL_ResPhase.Phase_Date is a SQL `datetime`, which carries no offset, and the
 * plant writes it in Rockford wall-clock time. The mssql driver hands those bare
 * digits back as a Date (i.e. tagged UTC), so the connector's `last_phase_at`
 * reads five hours older than the event actually was. Verified on site against
 * the live DB: the newest row across the line matched America/Chicago to within
 * six seconds, while UTC was 300 minutes off and the server's own clock — the DB
 * host sits in Italy at UTC+2 — was 420 minutes off.
 *
 * Left uncorrected this is the worst kind of wrong: a director asks what the
 * line is doing, and a station that stamped a phase 30 seconds ago is reported
 * as quiet for five hours. So resolve the real instant here and hand the model
 * an explicit age, rather than a timestamp it has to label a zone for.
 */
const PLANT_TZ = "America/Chicago";

/** Read bare `YYYY-MM-DDTHH:MM:SS` digits as wall time in `tz`. */
function wallTimeToInstant(naive: string, tz: string): Date | null {
  const digits = naive.replace(/(\.\d+)?Z?$/, "");
  const asIfUtc = new Date(`${digits}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;
  // How that instant reads in the plant zone; the gap is the zone's offset for
  // this date, so DST is handled without a tz library. Ambiguous only inside a
  // transition hour, where being an hour out is harmless for "how long ago".
  const inZone = new Date(
    `${asIfUtc.toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T")}Z`,
  );
  return new Date(asIfUtc.getTime() + (asIfUtc.getTime() - inZone.getTime()));
}

function humanAge(ms: number, lang: "en" | "it"): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return lang === "it" ? "meno di un minuto" : "less than a minute";
  if (mins < 60) return lang === "it" ? `${mins} minuti` : `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hs = lang === "it" ? (h === 1 ? "1 ora" : `${h} ore`) : h === 1 ? "1 hour" : `${h} hours`;
  if (!m) return hs;
  return lang === "it" ? `${hs} e ${m} minuti` : `${hs} ${m} minutes`;
}

/** Replace the mislabelled timestamp with a plant-local reading plus an age. */
function withPlantTime(
  snapshot: Record<string, unknown> | null,
  lang: "en" | "it",
): Record<string, unknown> | null {
  if (!snapshot) return null;
  const raw = snapshot.last_phase_at;
  if (typeof raw !== "string" || !raw) return snapshot;
  const instant = wallTimeToInstant(raw, PLANT_TZ);
  if (!instant) return snapshot;

  const { last_phase_at: _drop, ...rest } = snapshot;
  const ageMs = Date.now() - instant.getTime();
  return {
    ...rest,
    last_phase_local_time: raw.replace(/(\.\d+)?Z?$/, "").replace("T", " "),
    last_phase_timezone: `${PLANT_TZ} (plant floor local time, NOT UTC)`,
    last_phase_age: humanAge(ageMs, lang),
    // A clock skew or a mid-transition read can put this slightly in the
    // future; say so rather than emitting a negative age.
    ...(ageMs < -60000 ? { last_phase_age_note: "timestamp is ahead of this server's clock" } : {}),
  };
}

function askSystemPrompt(lang: "en" | "it"): string {
  return [
    "You are the live-line assistant for Comer Industries' Rockford axle line.",
    "You answer questions from plant directors and managers about what the MES",
    "(UNICOMM / SSL04_FARGO, read-only) is reporting right now.",
    "",
    "HARD RULES:",
    "- Answer ONLY from the JSON data given in the user message. It is the",
    "  complete output of the read-only MES connector for this question.",
    "- NEVER invent a value. If the question asks for something the JSON does",
    "  not contain (shift totals, scrap rates, OEE, history, other stations),",
    "  say plainly that the current MES snapshot does not carry it and name",
    "  what it does carry. Do not estimate or extrapolate.",
    "- If mode is 'stub', the numbers are demo values standing in for the",
    "  connector: answer normally, then end with one short sentence taking its",
    "  wording from data_source — say the line connection has dropped when it",
    "  reports a failed read, and that the bridge is not connected yet when it",
    "  reports none configured. Never conflate the two.",
    "- Keep MES vocabulary exact: station ids (ST100, PG-04), step codes (S09),",
    "  serials, part numbers, UNICOMM, SSL04_FARGO, units (Nm, mm).",
    "- Never quote raw JSON field names or nulls (current_step_result: null) —",
    "  you are writing for a plant director, so say what it means instead",
    "  ('the step has not been signed off yet').",
    "- Be concise and decision-ready: 1-3 sentences, no preamble, no bullet",
    "  lists unless you are naming more than three values.",
    "- Reply in plain text, not JSON or markdown.",
    "",
    /* Field meanings a model would otherwise guess at, plausibly and wrongly.
       A director cannot tell a real reading from a confident gloss, so the ones
       that carry a caveat are spelled out here. */
    "MES VOCABULARY — use these meanings exactly, do not invent your own:",
    "- current_phase_id / current_step_title: the operation the line is actually",
    "  performing, read straight from the MES. Always safe to report.",
    "- program_mapped: false means the station is running the same operation",
    "  under a DIFFERENT test program (another axle variant) than the tracked",
    "  one, so the step NUMBER is unavailable — but the phase, serial, operator",
    "  and time are live and correct. Report what the station is doing and, only",
    "  if asked about step numbering, note the variant. Never describe this as",
    "  idle, as a fault, or as a data problem.",
    "- session_active: whether a phase was written recently. If it is true the",
    "  station is working, regardless of program_mapped.",
    "- Times: last_phase_local_time is plant-floor local time on the Rockford",
    "  line. NEVER call it UTC and never convert it. Lead with",
    "  last_phase_age ('last activity 3 minutes ago'), which is what a director",
    "  actually needs, and give the clock time only as supporting detail.",
    "",
    lang === "it"
      ? "LINGUA: rispondi in ITALIANO, registro tecnico da stabilimento. Lascia invariati: id stazione, codici fase, seriali, part number, MES/UNICOMM/SSL04_FARGO e le unità di misura."
      : "LANGUAGE: reply in English.",
  ].join("\n");
}

lineRouter.post("/ask", async (req, res, next) => {
  try {
    const body = AskSchema.parse(req.body);
    const lang = body.lang ?? "en";
    const wantsWarnings = WARNING_RE.test(body.query);

    const [status, report] = await Promise.all([
      resolveLineStatus(),
      wantsWarnings ? resolveLineReport() : Promise.resolve(null),
    ]);

    /* With a database configured, hand the question to the SQL-backed path. It
       can answer things no snapshot can — shift counts, per-station history,
       torque distributions — and still receives the snapshot as context, so
       "what is on the line now" costs no extra query. Glasses-warning questions
       stay here: those come from the platform's own report, not the MES.

       Falls through to the snapshot-only answer below when no database is
       configured, which keeps the demo path working off-site. */
    if (mesConfigured() && status.source === "sql" && !wantsWarnings) {
      const result = await askMes(body.query, lang, status.snapshot);
      res.json({
        ok: true,
        answer: plainify(result.answer),
        mode: status.mode,
        connected: status.connected,
        source: "sql",
        sql: result.sql,
        rowCount: result.rowCount,
        queryMs: result.elapsedMs,
        snapshot: status.snapshot,
        mes: status.mes,
      });
      return;
    }

    // Label each source so the model never presents glasses warnings as MES
    // checks (they are different systems with different meanings).
    const grounding = {
      mode: status.mode,
      // "reconnecting" means a bridge IS configured but this read failed —
      // a dropped connection, not an un-deployed one. The two need different
      // caveats in the answer.
      data_source:
        status.mode === "live"
          ? "live read from the UNICOMM MES connector"
          : status.degraded === "reconnecting"
            ? "DEMO FALLBACK — the line bridge is configured but the last read failed, so the line connection has dropped"
            : "DEMO FALLBACK — no line bridge is configured yet",
      mes_connection: status.mes,
      workstation_snapshot_from_mes: withPlantTime(
        status.snapshot as Record<string, unknown> | null,
        lang,
      ),
      ...(report
        ? {
            glasses_warnings_report: {
              note:
                "Warnings fired by the smart glasses (CV/VLM), NOT MES quality checks.",
              period: (report as Record<string, unknown>).period,
              totals: (report as Record<string, unknown>).totals,
              per_worker: (report as Record<string, unknown>).workers,
            },
          }
        : {}),
    };

    const llm = await llmCall({
      route: "line-ask",
      system: askSystemPrompt(lang),
      user: [
        `QUESTION: ${body.query}`,
        "",
        "MES CONNECTOR DATA (the only facts you may use):",
        JSON.stringify(grounding, null, 2),
      ].join("\n"),
      // Italian prose runs longer for the same content — give it headroom.
      maxTokens: lang === "it" ? 420 : 280,
    });

    res.json({
      ok: true,
      answer: plainify(llm.text),
      mode: status.mode,
      connected: status.connected,
      mes: status.mes,
      snapshot: status.snapshot,
      degraded: status.degraded,
      fault: status.fault,
      detail: status.detail,
      usedReport: Boolean(report),
      stubbed: llm.stubbed,
      latencyMs: llm.latencyMs,
    });
  } catch (e) {
    next(e);
  }
});
