/**
 * LLM usage and cost report — backs the "Usage & cost" section of /settings.
 *
 * Read-only aggregation over the ledger written by services/usage.ts. Grouped
 * by surface, model and day, because the question a plant director actually
 * asks is "which feature is costing us money?" rather than "how many tokens
 * did we send?".
 */
import { Router } from "express";

import { usageSummary } from "../services/usage.js";

export const usageRouter = Router();

usageRouter.get("/summary", (_req, res) => {
  res.json(usageSummary());
});
