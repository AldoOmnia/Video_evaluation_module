import { z } from "zod";
import { ErrorCodeSchema } from "./taxonomy.js";

export const RiskSchema = z.enum(["low", "med", "high"]);

export const ErrorProfileSchema = z.object({
  high_priority: z.array(ErrorCodeSchema).default([]),
  medium_priority: z.array(ErrorCodeSchema).default([]),
  low_priority: z.array(ErrorCodeSchema).default([]),
  not_applicable: z.array(ErrorCodeSchema).default([]),
});

export const KeyStepSchema = z.object({
  id: z.string().regex(/^step:\d+$/),
  order: z.number().int().positive(),
  label: z.string(),
  description: z.string().optional(),
  risk: RiskSchema,
  acceptance: z.string(),
  dataReferences: z.array(z.string()).optional(),
  visualReferences: z.array(z.string()).optional(),
  errorRateData: z
    .object({ source: z.string(), column: z.string() })
    .optional(),
  errorProfile: ErrorProfileSchema,
});

export const InstructionSchema = z.object({
  id: z.string().regex(/^instr:\d+$/),
  label: z.string(),
  forStep: z.string().regex(/^step:\d+$/),
});

export const ExpertAdviceSchema = z.object({
  id: z.string().regex(/^advice:\d+$/),
  label: z.string(),
  forStep: z.string().regex(/^step:\d+$/),
  source: z.string(),
});

export const ToolSchema = z.object({
  id: z.string().startsWith("tool:"),
  label: z.string(),
  sku: z.string(),
});

export const PartSchema = z.object({
  id: z.string().startsWith("part:"),
  label: z.string(),
  sku: z.string(),
});

export const StepRequirementSchema = z.object({
  tools: z.array(z.string().startsWith("tool:")),
  parts: z.array(z.string().startsWith("part:")),
});

export const ProceduralActivitySchema = z.object({
  id: z.string().startsWith("proc:"),
  label: z.string(),
  description: z.string().optional(),
  cycleMin: z.number().positive(),
  stationId: z.string(),
});

export const ProcedureSpecSchema = z.object({
  proceduralActivity: ProceduralActivitySchema,
  keysteps: z.array(KeyStepSchema).min(1),
  instructions: z.array(InstructionSchema).default([]),
  expertAdvice: z.array(ExpertAdviceSchema).default([]),
  tools: z.array(ToolSchema).default([]),
  parts: z.array(PartSchema).default([]),
  stepRequirements: z.record(z.string(), StepRequirementSchema).default({}),
});

export type Risk = z.infer<typeof RiskSchema>;
export type ErrorProfile = z.infer<typeof ErrorProfileSchema>;
export type KeyStep = z.infer<typeof KeyStepSchema>;
export type Instruction = z.infer<typeof InstructionSchema>;
export type ExpertAdvice = z.infer<typeof ExpertAdviceSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type Part = z.infer<typeof PartSchema>;
export type StepRequirement = z.infer<typeof StepRequirementSchema>;
export type ProceduralActivity = z.infer<typeof ProceduralActivitySchema>;
export type ProcedureSpec = z.infer<typeof ProcedureSpecSchema>;
