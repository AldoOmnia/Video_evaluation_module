/**
 * /api/reshim — daily reshim report bookkeeping + on-demand trigger.
 *
 *   GET  /api/reshim/latest             newest run's summary + KPIs
 *   GET  /api/reshim/runs?limit=30      list historical runs (default 30)
 *   GET  /api/reshim/timeseries?days=30 OK% per day for the sparkline
 *   GET  /api/reshim/runs/:date/report  download the xlsx for a specific day
 *   POST /api/reshim/trigger            run the Python pipeline now
 *
 * Trigger is guarded: only one run at a time.
 */
import { Router } from "express";
import { existsSync, statSync, createReadStream } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";

import {
  latestRun,
  listRuns,
  okPctTimeseries,
  runReportPath,
  triggerRun,
} from "../services/reshim.js";

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
