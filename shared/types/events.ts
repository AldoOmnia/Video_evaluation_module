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
export const FourRoleLensSchema = z.object({
  label: z.string().default(""),
  value: z.string().default(""),
  action: z.string().default(""),
  source: z.string().default(""),
});
export type FourRoleLens = z.infer<typeof FourRoleLensSchema>;

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
  /** Role-tagged 4-line AnswerCard rendered on the worker's lens.
   *  Mirrors comer-rokid-demo/.../ui/AnswerCard.kt 1:1. */
  lens: FourRoleLensSchema.default({ label: "", value: "", action: "", source: "" }),
  /** Legacy flat 4-line projection of lens, kept for back-compat consumers. */
  glassesMessage: z.array(z.string()).default([]),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/** Accept `null` as equivalent to "field omitted" so JSON serializers that
 *  emit `"errorType": null` for correct events don't blow up validation. */
const nullable = <T extends z.ZodTypeAny>(s: T) =>
  s.optional().nullable().transform((v) => (v === null ? undefined : v));

export const SessionEventSchema = z.object({
  ts: z.number().nonnegative(),
  phase: z.string(),
  stepId: nullable(z.string().regex(/^step:\d+$/)),
  label: z.enum(["correct", "incorrect", "ambiguous"]),
  errorType: nullable(ErrorCodeSchema),
  priority: nullable(PrioritySchema),
  outcome: nullable(OutcomeSchema),
  inputTokens: nullable(z.number().int().nonnegative()),
  outputTokens: nullable(z.number().int().nonnegative()),
  latencyMs: nullable(z.number().nonnegative()),
  rationale: nullable(z.string()),
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
