/**
 * Reshim daily-run bookkeeping.
 *
 * Runs live on disk under `shared/data/reshim-runs/<YYYY-MM-DD>/` and are
 * produced by the Python CLI at `tools/reshim/`. This module lists them,
 * reads their summaries for the dashboard tab, and offers to spawn a fresh
 * run on demand (`POST /api/reshim/trigger`). It does not itself compute
 * anything — the Python side is the source of truth so the daily cron and
 * the on-demand button take exactly the same path.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, SHARED_DIR } from "../paths.js";

/* Overridable because the cloud deploy keeps runs on a mounted disk rather than
 * inside the checkout, which is wiped on every deploy. Defaults to the in-repo
 * path so local and on-prem installs need no configuration. */
const RUN_ROOT = process.env.RESHIM_RUN_ROOT?.trim() || join(SHARED_DIR, "data", "reshim-runs");

/* Runs committed to the repository, read-only. Anything the agent produced that
 * is worth keeping goes here, and then appears on every host that checks the
 * code out — a cloud deploy with an empty disk, a fresh clone, a new client
 * environment. `reshim-runs/` is ignored by git precisely because it is scratch
 * output from whichever machine last ran the agent; this is the kept record.
 *
 * Read from alongside RUN_ROOT rather than copied into it: the checkout is
 * replaced on every deploy, so copying would run on every boot and a write
 * failure would be silent. The live root wins on a date present in both, so a
 * real run published later supersedes its archived copy. */
const ARCHIVE_ROOT = join(SHARED_DIR, "data", "reshim-archive");

const PLANT_TZ = process.env.MES_PLANT_TZ?.trim() || "America/Chicago";

/** Calendar day in the plant zone (not UTC). Matches tools.reshim plant_today(). */
function plantToday(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: PLANT_TZ }).slice(0, 10);
}

export interface ReshimSummary {
  total: number;
  excluded: number;
  ok: number;
  bad: number;
  bad_heavy: number;
  unknown_family: number;
  by_family: Record<string, Record<string, number>>;
  by_variant: Record<string, Record<string, number>>;
  high_bad_variants: Array<{ variant: string; n: number; bad_pct: number }>;
}

export interface ReshimRunListItem {
  date: string;                    // YYYY-MM-DD
  hasReport: boolean;
  reportName: string | null;       // xlsx filename inside the day's folder
  emailStatus: "sent" | "failed" | "skipped" | null;
  emailRecipients: string[];
  summary: ReshimSummary | null;
  createdAt: number;               // ms since epoch (folder mtime)
  mock: boolean;                   // seeded demo data, not a real analysis
}

/** Marker dropped next to a seeded run. A demo instance is reachable on the
 *  same public hostname as the real thing, and nobody should have to guess
 *  whether the OK% on screen came from the line. */
const MOCK_MARKER = "MOCK";

function ensureRoot(): void {
  if (!existsSync(RUN_ROOT)) mkdirSync(RUN_ROOT, { recursive: true });
}

function safeReadJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Where a given day's artifacts are, live root first. Null when neither has it. */
function runDir(dateStr: string): string | null {
  for (const root of [RUN_ROOT, ARCHIVE_ROOT]) {
    const dir = join(root, dateStr);
    if (existsSync(dir)) return dir;
  }
  return null;
}

function loadRun(dateStr: string): ReshimRunListItem {
  const dir = runDir(dateStr) ?? join(RUN_ROOT, dateStr);
  const summary = safeReadJson<ReshimSummary>(join(dir, "summary.json"));
  const email = safeReadJson<{ status: number; recipients: string[]; subject: string }>(
    join(dir, "email.json"),
  );

  let reportName: string | null = null;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".xlsx")) {
        reportName = f;
        break;
      }
    }
  }

  const emailStatus: ReshimRunListItem["emailStatus"] = email
    ? email.status >= 200 && email.status < 300 ? "sent" : "failed"
    : reportName ? "skipped" : null;

  const createdAt = existsSync(dir) ? statSync(dir).mtimeMs : 0;

  return {
    date: dateStr,
    hasReport: reportName !== null,
    reportName,
    emailStatus,
    emailRecipients: email?.recipients ?? [],
    summary,
    createdAt,
    mock: existsSync(join(dir, MOCK_MARKER)),
  };
}

export function listRuns(limit = 60): ReshimRunListItem[] {
  ensureRoot();
  const dates = new Set<string>();
  for (const root of [RUN_ROOT, ARCHIVE_ROOT]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(name)) dates.add(name);
    }
  }
  return [...dates]
    .sort()
    .reverse()
    .slice(0, limit)
    .map(loadRun);
}

export function latestRun(): ReshimRunListItem | null {
  const runs = listRuns(1);
  return runs[0] ?? null;
}

export function runReportPath(dateStr: string): string | null {
  const dir = runDir(dateStr);
  const item = loadRun(dateStr);
  if (!dir || !item.reportName) return null;
  return join(dir, item.reportName);
}

/* ── Can this host run the agent at all? ──────────────────────────────── */

/**
 * The agent is Python and talks to the plant's SQL Server over ODBC, so it only
 * runs where that toolchain and that network exist — a plant machine, or the
 * CI runner the daily workflow uses. The cloud deploy is a Node service with
 * neither, so triggering there used to surface a raw ImportError traceback in
 * the UI. Probing lets the dashboard say so up front instead.
 *
 * `tools/reshim/__init__.py` is empty, so importing the package proves nothing;
 * `tools.reshim.cli` is what pulls typer, pyodbc and the rest, and it is the
 * same chain `python -m tools.reshim` walks.
 */
export interface Toolchain {
  canTrigger: boolean;
  reason: string | null;   // human-readable, shown in the UI when it cannot
  python: string;
}

let toolchain: Promise<Toolchain> | null = null;

/** First line of a Python traceback that names the actual cause, so the UI gets
 *  "No module named 'typer'" rather than six frames of file paths. */
function explainImportFailure(stderr: string): string {
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const named = lines.reverse().find((l) => /^[A-Za-z_.]*(Error|Exception)\b/.test(l));
  return named ?? lines[0] ?? "python could not import the reshim agent";
}

export function probeToolchain(): Promise<Toolchain> {
  // Cached for the process lifetime: an interpreter does not gain modules while
  // the server is up, and the dashboard asks on every page load.
  if (toolchain) return toolchain;
  const python = process.env.RESHIM_PYTHON ?? "python3";
  toolchain = new Promise<Toolchain>((resolve) => {
    const child = spawn(python, ["-c", "import tools.reshim.cli"], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stderr = "";
    let settled = false;
    const finish = (t: Toolchain) => {
      if (settled) return;
      settled = true;
      resolve(t);
    };
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", () =>
      finish({ canTrigger: false, reason: `${python} is not available on this host`, python }),
    );
    child.on("close", (code) =>
      finish(
        code === 0
          ? { canTrigger: true, reason: null, python }
          : { canTrigger: false, reason: explainImportFailure(stderr), python },
      ),
    );
    // Importing pyodbc can block on a broken driver install; do not hang the request.
    setTimeout(() => {
      child.kill("SIGKILL");
      finish({ canTrigger: false, reason: "python import timed out after 10s", python });
    }, 10_000).unref();
  });
  return toolchain;
}

/* ── Spawn a fresh run ────────────────────────────────────────────────── */

export interface TriggerRequest {
  dateStr?: string;               // optional YYYY-MM-DD override
  skipEmail?: boolean;
  skipPoll?: boolean;
}

export interface TriggerResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  dateStr: string;
  durationMs: number;
}

export async function triggerRun(req: TriggerRequest): Promise<TriggerResult> {
  const dateStr = req.dateStr ?? plantToday();
  const args = ["-m", "tools.reshim", "run", "--date", dateStr];
  if (req.skipEmail) args.push("--no-email");
  if (req.skipPoll) args.push("--no-poll");

  const python = process.env.RESHIM_PYTHON ?? "python3";
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(python, args, {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: TriggerResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr ? `${stderr}\n${err}` : String(err),
        dateStr,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        dateStr,
        durationMs: Date.now() - started,
      });
    });
  });
}

/* ── Accept a run produced elsewhere ──────────────────────────────────── */

/**
 * The daily workflow runs the agent where the plant network and the Python
 * toolchain are, which is never the same host as the cloud dashboard. Without
 * this the deployed page can only ever say "no runs yet", because it reads the
 * run directory off local disk. Ingest lets the runner hand its output over.
 *
 * Writes the same three artifacts `loadRun` reads, so an ingested run is
 * indistinguishable from a locally produced one.
 */
export interface IngestRun {
  dateStr: string;
  summary: ReshimSummary;
  email?: { status: number; recipients: string[]; subject: string } | null;
  report?: { name: string; base64: string } | null;
  mock?: boolean;
}

export function saveIngestedRun(run: IngestRun): { wrote: string[] } {
  const dir = join(RUN_ROOT, run.dateStr);
  mkdirSync(dir, { recursive: true });
  const wrote: string[] = [];

  writeFileSync(join(dir, "summary.json"), JSON.stringify(run.summary, null, 2));
  wrote.push("summary.json");

  if (run.email) {
    writeFileSync(join(dir, "email.json"), JSON.stringify(run.email, null, 2));
    wrote.push("email.json");
  }

  if (run.report) {
    // The name lands in a filesystem path and later in a Content-Disposition
    // header, so keep it to a bare .xlsx filename — no separators, no traversal.
    const name = run.report.name;
    if (!/^[A-Za-z0-9._-]+\.xlsx$/.test(name) || name.startsWith(".")) {
      throw new Error("report.name must be a plain .xlsx filename");
    }
    writeFileSync(join(dir, name), Buffer.from(run.report.base64, "base64"));
    wrote.push(name);
  }

  if (run.mock) {
    writeFileSync(join(dir, MOCK_MARKER), "Seeded demo data. Not a real analysis.\n");
    wrote.push(MOCK_MARKER);
  }

  return { wrote };
}

/* ── Sample runs ──────────────────────────────────────────────────────── */

/** How many of the runs on disk are seeded rather than real. Lets the dashboard
 *  offer "clear" only when there is something to clear. */
export function countSampleRuns(): number {
  return listRuns(365).filter((r) => r.mock).length;
}

/**
 * Whether a genuine analysis already occupies this date, from either root.
 * Seeding covers a window of recent days and would otherwise write over a real
 * report — invented figures must never mask one.
 */
export function hasRealRun(dateStr: string): boolean {
  if (!runDir(dateStr)) return false;
  const run = loadRun(dateStr);
  return !run.mock && (run.summary !== null || run.hasReport);
}

/**
 * Remove every seeded run, leaving real ones alone — the marker file is the
 * only thing consulted, so a day that was later overwritten by a genuine
 * analysis survives. Sample data must never be the default state of a
 * client-visible dashboard, and this is how it gets taken back out.
 */
export function clearSampleRuns(): { removed: string[] } {
  ensureRoot();
  const removed: string[] = [];
  for (const run of listRuns(365)) {
    if (!run.mock) continue;
    // Only ever delete from the writable root. The archive is the kept record of
    // real runs and nothing seeded can land there, but this is a delete taking a
    // caller-influenced path, so it does not rely on that being true.
    const dir = join(RUN_ROOT, run.date);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(run.date);
  }
  return { removed };
}

/* ── Timeseries for dashboard sparkline ───────────────────────────────── */

export interface OkPctPoint {
  date: string;
  ok_pct: number | null;
  n: number;
}

export function okPctTimeseries(days = 30): OkPctPoint[] {
  return listRuns(days).reverse().map((r) => {
    const s = r.summary;
    if (!s) return { date: r.date, ok_pct: null, n: 0 };
    const included = s.ok + s.bad + s.bad_heavy;
    return {
      date: r.date,
      ok_pct: included > 0 ? (100 * s.ok) / included : null,
      n: included,
    };
  });
}
