import { z } from "zod";

export const HardwareSignalsSchema = z.object({
  eye_gaze: z.boolean(),
  camera: z.boolean(),
  display: z.boolean(),
  hand_track: z.boolean(),
  audio_in: z.boolean(),
  audio_out: z.boolean(),
});

/**
 * Per-role budget for the 4-line AnswerCard rendered on glass.
 * Matches comer-rokid-demo/glasses-app/.../ui/AnswerCard.kt where:
 *   line1 = small dim teal label (10sp)
 *   line2 = large white headline / value (22sp)
 *   line3 = teal corrective action (14sp)
 *   line4 = small gray context / next-step (10sp)
 * Char budgets are derived from the bottom-left card at ~85% screen
 * width on the Rokid AR3-class display; the bigger the font, the
 * fewer characters fit on the line.
 */
export const FourRoleBudgetSchema = z.object({
  label_chars: z.number().int().positive(),
  value_chars: z.number().int().positive(),
  action_chars: z.number().int().positive(),
  source_chars: z.number().int().positive(),
});

export const DisplayConstraintSchema = z.object({
  max_lines: z.number().int().positive(),
  max_chars_per_line: z.number().int().positive(),
  max_total_chars: z.number().int().positive(),
  rich_formatting: z.boolean(),
  /** Per-role char budgets. Optional for legacy single-budget profiles. */
  four_role_budget: FourRoleBudgetSchema.optional(),
});

export const HardwareProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  signals: HardwareSignalsSchema,
  dwell_threshold_ms: z.number().int().nullable(),
  latency_budget_ms: z.number().int(),
  display: DisplayConstraintSchema.optional(),
});

export const HardwareProfilesSchema = z.object({
  profiles: z.record(z.string(), HardwareProfileSchema),
});

export type HardwareSignals = z.infer<typeof HardwareSignalsSchema>;
export type DisplayConstraint = z.infer<typeof DisplayConstraintSchema>;
export type FourRoleBudget = z.infer<typeof FourRoleBudgetSchema>;
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;
export type HardwareProfiles = z.infer<typeof HardwareProfilesSchema>;
