import { z } from "zod";
import { HardwareProfileSchema } from "./hardware.js";
import { ContextStrategySchema } from "./strategy.js";
import { SessionEventSchema } from "./events.js";
import { ErrorCodeSchema, GroupIdSchema, PrioritySchema } from "./taxonomy.js";

const PerBucketCount = z.object({
  seen: z.number().int().nonnegative(),
  caught: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative().optional(),
});

export const RunMetricsSchema = z.object({
  anomalies: z.number().int().nonnegative(),
  caught: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative(),
  false_pos: z.number().int().nonnegative(),
  catch_rate: z.number().min(0).max(1),
  high_priority_catch_rate: z.number().min(0).max(1),
  medium_priority_catch_rate: z.number().min(0).max(1),
  low_priority_catch_rate: z.number().min(0).max(1).optional(),
  total_input_tokens: z.number().int().nonnegative(),
  total_output_tokens: z.number().int().nonnegative().optional(),
  avg_latency_ms: z.number().nonnegative(),
  byType: z.record(ErrorCodeSchema, PerBucketCount),
  byGroup: z.record(GroupIdSchema, PerBucketCount),
  byPriority: z.record(PrioritySchema, PerBucketCount),
});

export const RunResultSchema = z.object({
  id: z.string(),
  hardware: HardwareProfileSchema,
  strategy: ContextStrategySchema,
  timestamp: z.string().datetime(),
  procedureId: z.string().startsWith("proc:"),
  events: z.array(SessionEventSchema),
  metrics: RunMetricsSchema,
  notes: z.string().optional(),
});

export type RunMetrics = z.infer<typeof RunMetricsSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;
