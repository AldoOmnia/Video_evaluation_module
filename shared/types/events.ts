import { z } from "zod";
import { ErrorCodeSchema, PrioritySchema } from "./taxonomy";

/**
 * SessionEvent — the atomic unit of an evaluation timeline.
 *
 * For simulated sessions we generate these directly from the procedure spec
 * and each KeyStep's errorProfile. For real Comer footage the annotation
 * pipeline produces these from labeled video (see /annotation-pipeline).
 *
 * The Rokid APK can also emit these in production to feed back into the
 * eval set: an event stream of CV detections + FSM transitions + agent
 * decisions becomes ground-truth-able training data.
 */
export const OutcomeSchema = z.enum(["caught", "missed", "false_pos", "n/a"]);

/**
 * Structured contextual output the agent produces for each event.
 * Models the Ti-Prego contextual prompt: completed sequence, current state,
 * predicted next action, and the corrective glasses message — so the UI
 * (and the Rokid lens) can render it directly without parsing free-form text.
 */
export const AgentOutputSchema = z.object({
  detected: z.boolean(),
  errorCode: ErrorCodeSchema.nullable(),
  errorGroup: z.enum(["A", "B", "C", "D", "E"]).nullable().optional(),
  diagnosis: z.string().optional(),
  fix: z.string().optional(),
  /** Step labels (in order) the agent considers completed before this event. */
  completedSequence: z.array(z.string()).default([]),
  /** Step the worker is currently performing (or attempting). */
  currentStep: z.string().optional(),
  /** Next planned action the agent expects after correction. */
  nextAction: z.string().optional(),
  /** What the worker sees on the glasses — 4 short lines, ≤ ~22 chars each. */
  glassesMessage: z.array(z.string()).default([]),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export const SessionEventSchema = z.object({
  ts: z.number().nonnegative(),
  phase: z.string(),
  stepId: z.string().regex(/^step:\d+$/).optional(),
  label: z.enum(["correct", "incorrect", "ambiguous"]),
  errorType: ErrorCodeSchema.optional(),
  priority: PrioritySchema.optional(),
  outcome: OutcomeSchema.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  rationale: z.string().optional(),
  /** Rich, structured agent verdict (set by /api/eval when liveLLM is on). */
  agentOutput: AgentOutputSchema.optional(),
});

export type Outcome = z.infer<typeof OutcomeSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const VideoSegmentSchema = z.object({
  id: z.string().startsWith("vid:"),
  type: z.literal("VideoSegment"),
  label: z.string(),
  fileName: z.string(),
  timestampStart: z.number().nonnegative(),
  timestampEnd: z.number().nonnegative(),
  errorType: ErrorCodeSchema.optional(),
  isCorrectExecution: z.boolean(),
  attachedTo: z.string().regex(/^step:\d+$/),
});
export type VideoSegment = z.infer<typeof VideoSegmentSchema>;
