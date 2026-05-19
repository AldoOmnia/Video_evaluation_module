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
import { stubMode } from "../config.js";
import {
  buildPrompt,
  type AgentContext,
} from "../../../shared/prompt-assembly/buildPrompt.js";
import {
  buildAgentSystemPrompt,
} from "../../../shared/prompt-assembly/systemPrompt.js";
import { fitToDisplay } from "../../../shared/display-constraints/rokid.js";
import { SessionEventSchema, type SessionEvent, type AgentOutput } from "../../../shared/types/events.js";
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
          detections: deriveDetections(ev),
        };
        const prompt = buildPrompt(strat, specs.procedure, ctx);
        const completed = completedSequenceFor(step, specs.procedure);
        const nextStep = nextStepFor(step, specs.procedure);
        const userMsg = `${prompt.user}

CONTEXT FOR THIS SEGMENT
  procedure: ${specs.procedure.proceduralActivity.label} (Station ${specs.procedure.proceduralActivity.stationId})
  step: ${step.id} — ${step.label} (risk: ${step.risk})
  acceptance: ${step.acceptance}
  high-priority errors here: ${step.errorProfile.high_priority.join(", ") || "—"}
  completed so far (per FSM): ${completed.map((c) => `${c.id} ${c.label}`).join(" → ") || "(none — start of run)"}
  next planned action: ${nextStep ? `${nextStep.id} ${nextStep.label}` : "(end of procedure)"}
  worker note: ${ev.rationale ?? "(none)"}

YOUR TASK
Produce one JSON object per the Omnia Comer Pinion Guide v1 schema described in the system prompt.
Use the Comer detection mechanisms + examples there. Compose a glasses message
in the same imperative style as the Ti-Prego contextual prompt — first line ALL CAPS,
subsequent lines short and concrete. ABSOLUTELY no prose outside the JSON.
`;
        const r = await llmCall({
          system: buildAgentSystemPrompt(specs.procedure, hw, specs.taxonomy),
          user: userMsg,
          maxTokens: 380,
        });
        totalIn += r.inputTokens;
        totalOut += r.outputTokens;
        latencies.push(r.latencyMs);
        const verdict = parseVerdict(r.text);
        // Enforce the lens display budget. We *always* word-wrap through
        // fitToDisplay so the worker never sees a mid-word truncation, even
        // if the LLM ignored the per-line cap. If the LLM emitted multiple
        // lines, we preserve the line breaks the model intended only when
        // each line fits; otherwise we concat and reflow.
        const maxChars = hw.display?.max_chars_per_line ?? 22;
        const maxLines = hw.display?.max_lines ?? 4;
        let glassesMessage: string[];
        const llmLines = verdict.glassesMessage ?? [];
        const allLinesFit =
          llmLines.length > 0 &&
          llmLines.length <= maxLines &&
          llmLines.every((l) => l.length <= maxChars);
        if (allLinesFit) {
          glassesMessage = llmLines.slice(0, maxLines);
        } else {
          // Reflow: join with single spaces (preserving paragraph intent) and
          // hand off to the canonical word-wrapper.
          const reflowSrc =
            llmLines.length > 0
              ? llmLines.join(" ")
              : verdict.fix || verdict.diagnosis || r.text;
          const fitted = fitToDisplay(reflowSrc, hw);
          glassesMessage = fitted.lines.filter((l) => l.length > 0);
          // Pad to maxLines so the lens preview always renders the full budget.
          while (glassesMessage.length < maxLines) glassesMessage.push("");
        }

        const truth = ev.errorType ?? null;
        const outcome: "caught" | "missed" | "false_pos" =
          verdict.detected && truth
            ? "caught"
            : verdict.detected && !truth
              ? "false_pos"
              : "missed";
        const codeMatch =
          truth && verdict.errorCode
            ? verdict.errorCode === truth
              ? "exact"
              : sameGroup(verdict.errorCode, truth)
                ? "same-group"
                : "different"
            : null;

        const agentOutput: AgentOutput = {
          detected: verdict.detected,
          errorCode: verdict.errorCode,
          errorGroup: verdict.errorCode
            ? specs.taxonomy.errors[verdict.errorCode]?.group ?? null
            : null,
          diagnosis: verdict.diagnosis,
          fix: verdict.fix,
          completedSequence:
            verdict.completedSequence.length > 0
              ? verdict.completedSequence
              : completed.map((c) => `${c.id} ${c.label}`),
          currentStep: verdict.currentStep || `${step.id} ${step.label}`,
          nextAction:
            verdict.nextAction ||
            (nextStep ? `${nextStep.id} ${nextStep.label}` : "(end of procedure)"),
          glassesMessage,
        };

        scored.push({
          ...ev,
          outcome,
          priority: ev.priority ?? priorityFor(step, ev.errorType),
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          latencyMs: r.latencyMs,
          agentOutput,
          rationale: [
            verdict.diagnosis ? `diagnosis: ${verdict.diagnosis}` : "",
            verdict.fix ? `fix: ${verdict.fix}` : "",
            verdict.errorCode
              ? `code: ${verdict.errorCode}${codeMatch && codeMatch !== "exact" ? ` (truth ${truth}, ${codeMatch})` : ""}`
              : truth
                ? `code: — (truth ${truth})`
                : "",
            `next: ${agentOutput.nextAction}`,
            `lens: "${glassesMessage.join(" / ")}"`,
          ]
            .filter(Boolean)
            .join(" | "),
        });
      } else {
        const sim = simulateOutcome(eff, strat.fp_rate, ev, step);
        totalIn += sim.inputTokens;
        totalOut += sim.outputTokens;
        latencies.push(sim.latencyMs);
        const truthLabel = ev.errorType
          ? specs.taxonomy.errors[ev.errorType]?.label ?? ev.errorType
          : "anomaly";
        const simRationale =
          sim.outcome === "caught"
            ? `sim · ${truthLabel} — caught by ${strat.name}`
            : sim.outcome === "missed"
              ? `sim · ${truthLabel} — MISSED · ${strat.name} catch-rate ${(strat.catch_rate_ideal * 100).toFixed(0)}% · enable LIVE LLM for a real verdict`
              : `sim · false-positive surfaced by ${strat.name}`;
        scored.push({
          ...ev,
          priority: ev.priority ?? priorityFor(step, ev.errorType),
          ...sim,
          rationale: ev.rationale ? `${ev.rationale} · ${simRationale}` : simRationale,
        });
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
    // attach a stubbed flag so the UI can self-correct its LLM pill
    res.json({ ...result, stubbed: stubMode || !body.liveLLM });
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
  // Cap at 0.92 (not 0.99) so even the best-tuned strategy produces the
  // occasional miss — important for demo/eval visibility. The strategy's
  // headline catch_rate_ideal still dominates lower strategies.
  const p = Math.min(0.92, eff * priorityBoost);
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

function sameGroup(a: ErrorCode, b: ErrorCode): boolean {
  return specs.taxonomy.errors[a]?.group === specs.taxonomy.errors[b]?.group;
}

interface AgentVerdict {
  detected: boolean;
  errorCode: ErrorCode | null;
  diagnosis: string;
  fix: string;
  completedSequence: string[];
  currentStep: string;
  nextAction: string;
  glassesMessage: string[];
}

/** Robust extraction of the full contextual verdict from the LLM. Tries every
 *  JSON object in the text and picks the most complete candidate. Falls back
 *  to a code-mention heuristic so we never return nothing. */
function parseVerdict(text: string): AgentVerdict {
  const stripped = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const candidates = extractJsonObjects(stripped);
  let best: AgentVerdict | null = null;
  let bestScore = -1;
  for (const obj of candidates) {
    const ecRaw = typeof obj.errorCode === "string" ? obj.errorCode.toUpperCase() : null;
    const ec =
      ecRaw && (ERROR_CODES as readonly string[]).includes(ecRaw) ? (ecRaw as ErrorCode) : null;
    const diag = String(obj.diagnosis ?? "").slice(0, 240);
    const fix = String(obj.fix ?? "").slice(0, 240);
    const detected = !!obj.detected || !!ec;
    const completedSequence = toStringArray(obj.completedSequence).slice(0, 24);
    const currentStep = String(obj.currentStep ?? "").slice(0, 120);
    const nextAction = String(obj.nextAction ?? "").slice(0, 200);
    const glassesMessage = toStringArray(obj.glassesMessage).slice(0, 6);
    const score =
      (diag ? 2 : 0) +
      (ec ? 2 : 0) +
      (fix ? 1 : 0) +
      (detected ? 1 : 0) +
      (completedSequence.length > 0 ? 1 : 0) +
      (currentStep ? 1 : 0) +
      (nextAction ? 1 : 0) +
      (glassesMessage.length > 0 ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = {
        detected,
        errorCode: ec,
        diagnosis: diag,
        fix,
        completedSequence,
        currentStep,
        nextAction,
        glassesMessage,
      };
    }
  }
  if (best && bestScore > 0) return best;

  // Heuristic fallback: if the text mentions a code, treat as detected.
  const found = (ERROR_CODES as readonly string[]).find((c) => stripped.toUpperCase().includes(c));
  return {
    detected: !!found,
    errorCode: (found as ErrorCode | undefined) ?? null,
    diagnosis: stripped.slice(0, 200),
    fix: "",
    completedSequence: [],
    currentStep: "",
    nextAction: "",
    glassesMessage: [],
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
}

/** Find every plausible JSON object in `s`, in order, ignoring braces inside
 *  strings. Brace-balanced scan; tolerant of leading prose and concatenation. */
function extractJsonObjects(s: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      const parsed = JSON.parse(s.slice(i, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* ignore — keep scanning */
    }
    i = end + 1;
  }
  return out;
}

/** All keysteps strictly before the current one, in procedure order. */
function completedSequenceFor(step: KeyStep, procedure: ProcedureSpec): KeyStep[] {
  return procedure.keysteps.filter((k) => k.order < step.order);
}

/** The next keystep after the current one (or null if at end). */
function nextStepFor(step: KeyStep, procedure: ProcedureSpec): KeyStep | null {
  return procedure.keysteps.find((k) => k.order === step.order + 1) ?? null;
}

/** Derive minimal CV-like detections from a labeled event so the prompt has
 *  something concrete to ground on, without requiring an actual CV pipeline. */
function deriveDetections(ev: { stepId?: string }): Record<string, number> {
  const out: Record<string, number> = {};
  if (!ev.stepId) return out;
  const req = specs.procedure.stepRequirements[ev.stepId];
  if (!req) return out;
  for (const t of req.tools) out[t] = 0.9;
  for (const p of req.parts) out[p] = 0.88;
  return out;
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
