import { z } from "zod";

export const HardwareSignalsSchema = z.object({
  eye_gaze: z.boolean(),
  camera: z.boolean(),
  display: z.boolean(),
  hand_track: z.boolean(),
  audio_in: z.boolean(),
  audio_out: z.boolean(),
});

export const DisplayConstraintSchema = z.object({
  max_lines: z.number().int().positive(),
  max_chars_per_line: z.number().int().positive(),
  max_total_chars: z.number().int().positive(),
  rich_formatting: z.boolean(),
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
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;
export type HardwareProfiles = z.infer<typeof HardwareProfilesSchema>;
