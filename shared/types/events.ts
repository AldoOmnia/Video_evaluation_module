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
