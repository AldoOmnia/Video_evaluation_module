import { z } from "zod";

export const StrategyLayerSchema = z.union([
  z.literal(1), // On-device CV
  z.literal(2), // Procedural memory FSM
  z.literal(3), // Tier-1 rule check
  z.literal(4), // Tier-2 LLM reasoning
  z.literal(5), // Display constraint
]);

export const ContextStrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  layers: z.array(StrategyLayerSchema),
  avg_input_tokens: z.number().positive(),
  catch_rate_ideal: z.number().min(0).max(1),
  fp_rate: z.number().min(0).max(1),
});

export const StrategiesSchema = z.object({
  strategies: z.record(z.string(), ContextStrategySchema),
});

export type StrategyLayer = z.infer<typeof StrategyLayerSchema>;
export type ContextStrategy = z.infer<typeof ContextStrategySchema>;
export type Strategies = z.infer<typeof StrategiesSchema>;
