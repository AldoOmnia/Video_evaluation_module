/**
 * Emotiv portal services. This branch does not serve the Comer line,
 * glasses, or reshim feeds. Both routes stay unconfigured until the
 * Emotiv agent and monitoring data are attached.
 */
import { Router } from "express";

export const emotivRouter = Router();

emotivRouter.get("/agent", (_req, res) => {
  res.json({
    ok: true,
    service: "agent",
    configured: false,
    note: "The Emotiv agent is not connected yet. This slot is ready for its model, tools, and session data.",
  });
});

emotivRouter.get("/monitor", (_req, res) => {
  res.json({
    ok: true,
    service: "monitor",
    configured: false,
    note: "Emotiv monitoring is not connected yet. This slot is ready for the session stream.",
  });
});
