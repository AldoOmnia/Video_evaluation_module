/**
 * /api/reshim — daily reshim report bookkeeping + on-demand trigger.
 *
 *   GET  /api/reshim/latest             newest run's summary + KPIs
 *   GET  /api/reshim/runs?limit=30      list historical runs (default 30)
 *   GET  /api/reshim/timeseries?days=30 OK% per day for the sparkline
 *   GET  /api/reshim/runs/:date/report  download the xlsx for a specific day
 *   GET  /api/reshim/capabilities       whether this host can run / can email
 *   POST /api/reshim/trigger            run the Python pipeline now
 *   POST /api/reshim/runs               ingest a run produced on another host
 *   POST /api/reshim/sample             seed invented runs (demo), optionally email
 *   DELETE /api/reshim/sample           remove every seeded run
 *
 * Trigger is guarded: only one run at a time, and only where the Python
 * toolchain exists. Ingest is guarded by a bearer token; the sample routes by
 * the platform login.
 */
import { Router } from "express";
import { existsSync, statSync, createReadStream } from "node:fs";
import { basename } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  clearSampleRuns,
  countSampleRuns,
  latestRun,
  listRuns,
  okPctTimeseries,
  probeToolchain,
  runReportPath,
  saveIngestedRun,
  triggerRun,
} from "../services/reshim.js";
import { seedSampleRuns } from "../services/reshim-sample.js";
import { mailCapability } from "../services/mail.js";
import { requireSession } from "./auth.js";

export const reshimRouter = Router();

reshimRouter.get("/latest", (_req, res) => {
  res.json({ ok: true, run: latestRun() });
});

reshimRouter.get("/runs", (req, res) => {
  const limit = Math.max(1, Math.min(365, Number(req.query.limit ?? 30)));
  res.json({ ok: true, runs: listRuns(limit) });
});

reshimRouter.get("/timeseries", (req, res) => {
  const days = Math.max(1, Math.min(180, Number(req.query.days ?? 30)));
  res.json({ ok: true, points: okPctTimeseries(days) });
});

reshimRouter.get("/runs/:date/report", (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD" });
  }
  const path = runReportPath(date);
  if (!path || !existsSync(path)) {
    return res.status(404).json({ ok: false, error: "no report for that date" });
  }
  const size = statSync(path).size;
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${basename(path)}"`);
  res.setHeader("Content-Length", size.toString());
  createReadStream(path).pipe(res);
});

reshimRouter.get("/capabilities", async (_req, res, next) => {
  try {
    const t = await probeToolchain();
    const m = mailCapability();
    res.json({
      ok: true,
      canTrigger: t.canTrigger,
      reason: t.reason,
      // Emailing is independent of running: the cloud host cannot compute a
      // report but can perfectly well send one, so the two are reported apart.
      canEmail: m.canSend,
      emailReason: m.reason,
      recipientCount: m.recipients.length,
      sampleRuns: countSampleRuns(),
    });
  } catch (e) {
    next(e);
  }
});

/* ── Sample data ──────────────────────────────────────────────────────── */

const SampleBody = z.object({
  days: z.number().int().min(1).max(90).optional(),
  email: z.boolean().optional(),
});

/**
 * Seeding and clearing are behind the platform login, unlike the reads on this
 * router: seeding can send mail to the customer's distribution list, and
 * clearing deletes from disk.
 */
reshimRouter.post("/sample", requireSession, async (req, res, next) => {
  try {
    const body = SampleBody.parse(req.body ?? {});
    if (body.email) {
      const m = mailCapability();
      if (!m.canSend) {
        return res.status(503).json({ ok: false, error: `Cannot send mail: ${m.reason}` });
      }
    }
    const result = await seedSampleRuns(body.days ?? 30, { email: body.email });
    res.json({ ok: true, ...result });
  } catch (e) {
    // A send failure still leaves seeded runs on disk, which is the useful
    // half; say so rather than implying nothing happened.
    if (e instanceof Error && /Graph|token request/.test(e.message)) {
      return res.status(502).json({ ok: false, error: e.message, seeded: true });
    }
    next(e);
  }
});

reshimRouter.delete("/sample", requireSession, (_req, res, next) => {
  try {
    const { removed } = clearSampleRuns();
    res.json({ ok: true, removed: removed.length, dates: removed });
  } catch (e) {
    next(e);
  }
});

/* ── Trigger a run (single-flight) ────────────────────────────────────── */

let inflight: Promise<unknown> | null = null;
let lastTriggered: number | null = null;

const TriggerBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  skipEmail: z.boolean().optional(),
  skipPoll: z.boolean().optional(),
});

reshimRouter.post("/trigger", async (req, res, next) => {
  if (inflight) {
    return res.status(409).json({
      ok: false,
      error: "a run is already in progress",
      startedAt: lastTriggered,
    });
  }
  try {
    // Fail with a sentence rather than letting the UI print a Python traceback
    // on hosts that were never provisioned to run the agent.
    const t = await probeToolchain();
    if (!t.canTrigger) {
      return res.status(503).json({
        ok: false,
        error: `This host cannot run the reshim agent (${t.reason}). ` +
          "Runs happen on the plant network via the daily workflow.",
      });
    }
    const body = TriggerBody.parse(req.body ?? {});
    lastTriggered = Date.now();
    const runP = triggerRun({
      dateStr: body.date,
      skipEmail: body.skipEmail,
      skipPoll: body.skipPoll,
    });
    inflight = runP;
    const result = await runP;
    inflight = null;
    // 502 when the Python side failed so the UI can surface a real error
    res.status(result.ok ? 200 : 502).json({ ok: result.ok, result });
  } catch (e) {
    inflight = null;
    next(e);
  }
});

/* ── Ingest a run from the host that produced it ───────────────────────── */

const IngestBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.object({
    total: z.number(),
    excluded: z.number(),
    ok: z.number(),
    bad: z.number(),
    bad_heavy: z.number(),
    unknown_family: z.number(),
    by_family: z.record(z.record(z.number())),
    by_variant: z.record(z.record(z.number())),
    high_bad_variants: z.array(
      z.object({ variant: z.string(), n: z.number(), bad_pct: z.number() }),
    ),
  }),
  email: z
    .object({
      status: z.number(),
      recipients: z.array(z.string()),
      subject: z.string(),
    })
    .nullish(),
  report: z
    .object({ name: z.string().max(200), base64: z.string() })
    .nullish(),
  mock: z.boolean().optional(),
});

/** Constant-time bearer check against RESHIM_INGEST_TOKEN. Unset means the
 *  endpoint is closed rather than open — this route writes to disk, and no
 *  other endpoint here is authenticated, so it must not default to allowing. */
function ingestAuthorized(header: string | undefined): boolean {
  const expected = process.env.RESHIM_INGEST_TOKEN?.trim();
  if (!expected) return false;
  const got = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

reshimRouter.post("/runs", (req, res, next) => {
  if (!process.env.RESHIM_INGEST_TOKEN?.trim()) {
    return res.status(503).json({ ok: false, error: "ingest is not configured on this host" });
  }
  if (!ingestAuthorized(req.headers.authorization)) {
    return res.status(401).json({ ok: false, error: "invalid ingest token" });
  }
  try {
    const body = IngestBody.parse(req.body ?? {});
    const { wrote } = saveIngestedRun({
      dateStr: body.date,
      summary: body.summary,
      email: body.email ?? null,
      report: body.report ?? null,
      mock: body.mock ?? false,
    });
    res.json({ ok: true, date: body.date, wrote });
  } catch (e) {
    if (e instanceof Error && e.message.includes("report.name")) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    next(e);
  }
});
