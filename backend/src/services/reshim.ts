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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, SHARED_DIR } from "../paths.js";

/* Overridable because the cloud deploy keeps runs on a mounted disk rather than
 * inside the checkout, which is wiped on every deploy. Defaults to the in-repo
 * path so local and on-prem installs need no configuration. */
const RUN_ROOT = process.env.RESHIM_RUN_ROOT?.trim() || join(SHARED_DIR, "data", "reshim-runs");
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
}

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

function loadRun(dateStr: string): ReshimRunListItem {
  const dir = join(RUN_ROOT, dateStr);
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
  };
}

export function listRuns(limit = 60): ReshimRunListItem[] {
  ensureRoot();
  const dates = readdirSync(RUN_ROOT)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse()
    .slice(0, limit);
  return dates.map(loadRun);
}

export function latestRun(): ReshimRunListItem | null {
  const runs = listRuns(1);
  return runs[0] ?? null;
}

export function runReportPath(dateStr: string): string | null {
  const item = loadRun(dateStr);
  if (!item.reportName) return null;
  return join(RUN_ROOT, dateStr, item.reportName);
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

  return { wrote };
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
