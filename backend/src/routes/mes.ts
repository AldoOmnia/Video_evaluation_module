/**
 * /api/mes — direct read-only access to the UNICOMM MES database.
 *
 * The point of these three endpoints is that connecting is boring: set six
 * environment variables, hit /api/mes/health, and either it says connected or it
 * tells you exactly what failed. No second repo, no bridge process, no branch.
 *
 *   GET  /api/mes/health   is the database reachable, and is the plant moving?
 *   GET  /api/mes/schema   what the assistant is allowed to see
 *   POST /api/mes/ask      natural-language question → SQL → grounded answer
 */
import { Router } from "express";
import { z } from "zod";
import { askMes } from "../services/mesAsk.js";
import { mesConfigured, mesHealth, mesSchema } from "../services/mesSql.js";

export const mesRouter = Router();

mesRouter.get("/health", async (req, res, next) => {
  try {
    const lang = req.query.lang === "it" ? "it" : "en";
    const health = await mesHealth(lang);
    // 503 when configured but unreachable, so a curl in a terminal or an uptime
    // check fails loudly instead of returning 200 with connected:false buried
    // in the body.
    res.status(health.configured && !health.connected ? 503 : 200).json({
      ok: health.connected,
      ...health,
    });
  } catch (e) {
    next(e);
  }
});

mesRouter.get("/schema", async (_req, res, next) => {
  try {
    if (!mesConfigured()) {
      res.status(503).json({
        ok: false,
        error: "MES database is not configured (see MES_MSSQL_* environment variables)",
      });
      return;
    }
    const tables = await mesSchema();
    res.json({
      ok: true,
      tableCount: tables.length,
      tables: tables.map((t) => ({
        name: t.name,
        note: t.note,
        columns: t.columns.map((c) => `${c.name} ${c.type}`),
      })),
    });
  } catch (e) {
    next(e);
  }
});

const AskSchema = z.object({
  query: z.string().min(1).max(500),
  lang: z.enum(["en", "it"]).optional(),
});

mesRouter.post("/ask", async (req, res, next) => {
  try {
    const body = AskSchema.parse(req.body);
    if (!mesConfigured()) {
      res.status(503).json({
        ok: false,
        error: "MES database is not configured (see MES_MSSQL_* environment variables)",
      });
      return;
    }
    const result = await askMes(body.query, body.lang ?? "en");
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});
