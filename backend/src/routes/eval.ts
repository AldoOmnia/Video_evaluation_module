/**
 * POST /api/eval
 *
 * Body: { hardwareId, strategyId, events: SessionEvent[], procedureId? }
 * Returns: RunResult
 *
 * For each anomalous event we either call the real LLM (when configured)
 * or simulate the outcome using the strategy's `catch_rate_ideal` modulated
 * by hardware capability factors. This is the replacement for the in-browser
 * runEvaluation simulation.
 */
import { Router } from "express";
import { z } from "zod";

import { specs } from "../services/specs.js";
import { llmCall } from "../services/anthropic.js";
import {
  buildPrompt,
  type AgentContext,
} from "../../../shared/prompt-assembly/buildPrompt.js";
import {
  buildAgentSystemPrompt,
} from "../../../shared/prompt-assembly/systemPrompt.js";
import { fitToDisplay } from "../../../shared/display-constraints/rokid.js";
import { SessionEventSchema, type SessionEvent } from "../../../shared/types/events.js";
import type { ErrorCode, Priority } from "../../../shared/types/taxonomy.js";
import { ERROR_CODES } from "../../../shared/types/taxonomy.js";
import type { RunMetrics, RunResult } from "../../../shared/types/run.js";
import type { KeyStep, ProcedureSpec } from "../../../shared/types/procedure.js";

const BodySchema = z.object({
  hardwareId: z.string(),
  strategyId: z.string(),
  events: z.array(SessionEventSchema).min(1),
  procedureId: z.string().optional(),
  /** When true, calls real LLM. When false, runs the calibrated sim. */
  liveLLM: z.boolean().optional(),
});

export const evalRouter = Router();

evalRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const hw = specs.hardware.profiles[body.hardwareId];
    const strat = specs.strategies.strategies[body.strategyId];
    if (!hw) return res.status(400).json({ error: `unknown hardware ${body.hardwareId}` });
    if (!strat) return res.status(400).json({ error: `unknown strategy ${body.strategyId}` });

    const eff = effectiveCatchRate(strat.catch_rate_ideal, hw);
    const scored: SessionEvent[] = [];
    let totalIn = 0;
    let totalOut = 0;
    const latencies: number[] = [];

    for (const ev of body.events) {
      const step =
        specs.procedure.keysteps.find((s) => s.id === ev.stepId) ??
        specs.procedure.keysteps[0];

      if (ev.label === "correct") {
        scored.push({ ...ev, outcome: "n/a" });
        continue;
      }

      if (body.liveLLM) {
        const ctx: AgentContext = {
          currentStep: step,
          recentEvents: scored.slice(-8),
          detections: {},
        };
        const prompt = buildPrompt(strat, specs.procedure, ctx);
        const r = await llmCall({
          system: buildAgentSystemPrompt(specs.procedure, hw, specs.taxonomy),
          user: prompt.user,
          maxTokens: 200,
        });
        totalIn += r.inputTokens;
        totalOut += r.outputTokens;
        latencies.push(r.latencyMs);
        // Compress to display + score against ground truth
        const display = fitToDisplay(r.text, hw);
        const caught = mentionsErrorCode(display.lines.join(" "), ev.errorType);
        scored.push({
          ...ev,
          outcome: caught ? "caught" : "missed",
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          latencyMs: r.latencyMs,
          rationale: display.lines.join(" ").trim(),
        });
      } else {
        const sim = simulateOutcome(eff, strat.fp_rate, ev, step);
        totalIn += sim.inputTokens;
        totalOut += sim.outputTokens;
        latencies.push(sim.latencyMs);
        scored.push({ ...ev, ...sim });
      }
    }

    const metrics = computeMetrics(scored, totalIn, totalOut, latencies);

    const result: RunResult = {
      id: `r${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      hardware: hw,
      strategy: strat,
      timestamp: new Date().toISOString(),
      procedureId: specs.procedure.proceduralActivity.id,
      events: scored,
      metrics,
    };
    res.json(result);
  } catch (e) {
    next(e);
  }
});

function effectiveCatchRate(ideal: number, hw: typeof specs.hardware.profiles[string]): number {
  let eff = ideal;
  if (hw.signals.eye_gaze) eff = Math.min(1, eff * 1.05);
  if (!hw.signals.camera) eff *= 0.4;
  if (!hw.signals.display) eff *= 0.85;
  return eff;
}

function simulateOutcome(
  eff: number,
  fp: number,
  ev: SessionEvent,
  step: KeyStep,
): {
  outcome: "caught" | "missed" | "false_pos";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
} {
  const priority = ev.priority ?? priorityFor(step, ev.errorType);
  const priorityBoost =
    priority === "high" ? 1.1 : priority === "medium" ? 1.0 : 0.85;
  const p = Math.min(0.99, eff * priorityBoost);
  const rolled = Math.random();
  const outcome: "caught" | "missed" | "false_pos" =
    rolled < p ? "caught" : Math.random() < fp ? "false_pos" : "missed";
  return {
    outcome,
    inputTokens: 1200 + Math.floor(Math.random() * 600),
    outputTokens: 40 + Math.floor(Math.random() * 80),
    latencyMs: 180 + Math.floor(Math.random() * 400),
  };
}

function priorityFor(step: KeyStep, code?: ErrorCode): Priority {
  if (!code) return "low";
  if (step.errorProfile.high_priority.includes(code)) return "high";
  if (step.errorProfile.medium_priority.includes(code)) return "medium";
  return "low";
}

function mentionsErrorCode(text: string, code?: ErrorCode): boolean {
  if (!code) return false;
  return text.toUpperCase().includes(code);
}

function computeMetrics(
  events: SessionEvent[],
  totalIn: number,
  totalOut: number,
  latencies: number[],
): RunMetrics {
  const anomalies = events.filter((e) => e.label === "incorrect").length;
  let caught = 0;
  let missed = 0;
  let fp = 0;
  const byType: Record<string, { seen: number; caught: number; missed: number }> = {};
  const byGroup: Record<string, { seen: number; caught: number }> = {};
  const byPriority: Record<Priority, { seen: number; caught: number }> = {
    high: { seen: 0, caught: 0 },
    medium: { seen: 0, caught: 0 },
    low: { seen: 0, caught: 0 },
  };

  for (const e of events) {
    if (e.outcome === "caught") caught++;
    if (e.outcome === "missed") missed++;
    if (e.outcome === "false_pos") fp++;
    if (e.label !== "incorrect" || !e.errorType) continue;
    const code = e.errorType;
    byType[code] ??= { seen: 0, caught: 0, missed: 0 };
    byType[code].seen++;
    if (e.outcome === "caught") byType[code].caught++;
    if (e.outcome === "missed") byType[code].missed++;

    const group = groupFor(code) ?? "E";
    byGroup[group] ??= { seen: 0, caught: 0 };
    byGroup[group].seen++;
    if (e.outcome === "caught") byGroup[group].caught++;

    const p = e.priority ?? "low";
    byPriority[p].seen++;
    if (e.outcome === "caught") byPriority[p].caught++;
  }

  const catchRate = anomalies > 0 ? caught / anomalies : 0;
  const safeRate = (b: { seen: number; caught: number }) =>
    b.seen > 0 ? b.caught / b.seen : 0;

  return {
    anomalies,
    caught,
    missed,
    false_pos: fp,
    catch_rate: catchRate,
    high_priority_catch_rate: safeRate(byPriority.high),
    medium_priority_catch_rate: safeRate(byPriority.medium),
    low_priority_catch_rate: safeRate(byPriority.low),
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    avg_latency_ms:
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
    byType: byType as RunMetrics["byType"],
    byGroup: byGroup as RunMetrics["byGroup"],
    byPriority: byPriority as RunMetrics["byPriority"],
  };
}

function groupFor(code: ErrorCode): string | undefined {
  // Direct lookup against the loaded taxonomy
  return specs.taxonomy.errors[code]?.group;
}

// expose error codes for client-side validation
export const ERROR_CODES_FOR_CLIENT = ERROR_CODES;

// dummy reference to keep ProcedureSpec import used (some bundlers strip)
export type _ = ProcedureSpec;
