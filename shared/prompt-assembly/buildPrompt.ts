/**
 * Per-strategy prompt assembly.
 *
 * Each context strategy (A1-A4) determines what state goes into the user
 * message of the LLM call. This module is the only place where "what does
 * the LLM see" lives. The eval lab uses this to score strategies; the Rokid
 * APK uses this to construct production prompts.
 *
 * Keep this file pure (no I/O, no globals). It must run identically in
 * Node, the browser, and (transpiled) on the device.
 */
import type { ProcedureSpec, KeyStep } from "../types/procedure";
import type { ContextStrategy } from "../types/strategy";
import type { SessionEvent } from "../types/events";

export interface AgentContext {
  /** Current KeyStep the FSM believes the worker is in. */
  currentStep: KeyStep;
  /** Recent detection / FSM events, newest last. */
  recentEvents: SessionEvent[];
  /** Active CV detections (object → confidence). */
  detections: Record<string, number>;
  /** Optional OEM signal — undefined means OEM_UNAVAILABLE. */
  oemSignal?: { reportedStep: string; ts: number };
  /** Optional worker spoken query (Rokid voice). */
  workerQuery?: string;
}

export interface AssembledPrompt {
  /** What goes into the `messages: [{ role: 'user', content }]` slot. */
  user: string;
  /** Estimated input tokens (rough chars/4 heuristic). */
  estimatedTokens: number;
  /** Diagnostic for the eval lab. */
  layersUsed: number[];
}

const SEP = "\n---\n";

export function buildPrompt(
  strategy: ContextStrategy,
  procedure: ProcedureSpec,
  ctx: AgentContext,
): AssembledPrompt {
  switch (strategy.id) {
    case "baseline":
      return baseline(ctx);
    case "full_context":
      return fullContext(procedure, ctx);
    case "scoped_episodic":
      return scopedEpisodic(ctx);
    case "tiered_proactive":
      return tieredProactive(ctx);
    default:
      throw new Error(`Unknown strategy: ${strategy.id}`);
  }
}

function baseline(ctx: AgentContext): AssembledPrompt {
  const body = ctx.workerQuery
    ? `Worker said: "${ctx.workerQuery}". Respond.`
    : `Detections: ${stringifyDetections(ctx.detections)}. Anything wrong?`;
  return { user: body, estimatedTokens: estTok(body), layersUsed: [4] };
}

function fullContext(procedure: ProcedureSpec, ctx: AgentContext): AssembledPrompt {
  const allSteps = procedure.keysteps
    .map((s) => `${s.order}. ${s.label} — accept: ${s.acceptance}`)
    .join("\n");
  const allInstructions = procedure.instructions
    .map((i) => `${i.id} (${i.forStep}): ${i.label}`)
    .join("\n");
  const allAdvice = procedure.expertAdvice
    .map((a) => `${a.source}: "${a.label}"`)
    .join("\n");
  const events = ctx.recentEvents
    .map((e) => `t=${e.ts.toFixed(1)} ${e.phase} ${e.label}`)
    .join("\n");
  const body = [
    `# Procedure: ${procedure.proceduralActivity.label}`,
    allSteps,
    SEP,
    `# Instructions`,
    allInstructions,
    SEP,
    `# Expert advice`,
    allAdvice,
    SEP,
    `# Current detections`,
    stringifyDetections(ctx.detections),
    SEP,
    `# Event history`,
    events,
    ctx.workerQuery ? `${SEP}# Worker query\n${ctx.workerQuery}` : "",
  ].join("\n");
  return { user: body, estimatedTokens: estTok(body), layersUsed: [1, 2, 4] };
}

function scopedEpisodic(ctx: AgentContext): AssembledPrompt {
  const step = ctx.currentStep;
  // Last 60 seconds, max 12 events
  const cutoff =
    ctx.recentEvents.length > 0 ? (ctx.recentEvents.at(-1)?.ts ?? 0) - 60 : 0;
  const scoped = ctx.recentEvents.filter((e) => e.ts >= cutoff).slice(-12);
  const body = [
    `# Current step`,
    `${step.order}. ${step.label}`,
    `Acceptance: ${step.acceptance}`,
    step.errorProfile.high_priority.length
      ? `High-priority errors here: ${step.errorProfile.high_priority.join(", ")}`
      : "",
    SEP,
    `# Detections`,
    stringifyDetections(ctx.detections),
    SEP,
    `# Recent (≤60s, scoped to this step)`,
    scoped.map((e) => `t=${e.ts.toFixed(1)} ${e.phase} ${e.label}`).join("\n"),
    ctx.workerQuery ? `${SEP}# Worker query\n${ctx.workerQuery}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { user: body, estimatedTokens: estTok(body), layersUsed: [1, 2, 4] };
}

function tieredProactive(ctx: AgentContext): AssembledPrompt {
  const step = ctx.currentStep;
  const oem = ctx.oemSignal
    ? `OEM reports step ${ctx.oemSignal.reportedStep} (t=${ctx.oemSignal.ts.toFixed(1)})`
    : "OEM signal: UNAVAILABLE";
  // Only the most recent 5 events; relies on Tier-1 rules having already filtered.
  const recent = ctx.recentEvents.slice(-5);
  const body = [
    `# Tiered alert — Tier-1 rule fired`,
    `Step: ${step.order} ${step.label}`,
    `Acceptance: ${step.acceptance}`,
    `High-priority profile: ${step.errorProfile.high_priority.join(", ") || "—"}`,
    SEP,
    `# Detections`,
    stringifyDetections(ctx.detections),
    SEP,
    oem,
    SEP,
    `# Recent events`,
    recent.map((e) => `t=${e.ts.toFixed(1)} ${e.phase} ${e.label}`).join("\n"),
    ctx.workerQuery ? `${SEP}# Worker query\n${ctx.workerQuery}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    user: body,
    estimatedTokens: estTok(body),
    layersUsed: [1, 2, 3, 4, 5],
  };
}

function stringifyDetections(d: Record<string, number>): string {
  const entries = Object.entries(d);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}(${v.toFixed(2)})`).join(", ");
}

function estTok(s: string): number {
  return Math.ceil(s.length / 4);
}
