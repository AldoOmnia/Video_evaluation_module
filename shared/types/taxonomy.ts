import { z } from "zod";

export const ERROR_CODES = [
  // Group A — Sequence
  "OMISSION",
  "INSERTION",
  "ORDER",
  "INCOMPLETE",
  // Group B — Execution
  "SUBSTITUTION",
  "ORIENTATION",
  "OMITTED_OBJECT",
  "EXTRA_OBJECT",
  // Group C — Specification
  "OUT_OF_SPEC",
  "UNVERIFIED",
  "BORDERLINE",
  // Group D — Intent-vs-reality
  "INTENT_MISMATCH",
  "PHANTOM_PROGRESS",
  "UNREPORTED_PROGRESS",
  "STATE_REPAIR",
  // Group E — System
  "CV_UNCERTAIN",
  "STATE_AMBIGUOUS",
  "OEM_UNAVAILABLE",
  "OUT_OF_DISTRIBUTION",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const GroupIdSchema = z.enum(["A", "B", "C", "D", "E"]);
export type GroupId = z.infer<typeof GroupIdSchema>;

export const ErrorGroupSchema = z.object({
  label: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  desc: z.string(),
});

export const ErrorMetaSchema = z.object({
  group: GroupIdSchema,
  label: z.string(),
  desc: z.string(),
  /** How an Omnia agent detects this error class (mechanism, not value). */
  detection: z.string().optional(),
  /** A concrete Pinion Guide example, for grounding the LLM and the UI. */
  example: z.string().optional(),
});

export const TaxonomySchema = z.object({
  groups: z.record(GroupIdSchema, ErrorGroupSchema),
  errors: z.record(ErrorCodeSchema, ErrorMetaSchema),
});

export type ErrorGroup = z.infer<typeof ErrorGroupSchema>;
export type ErrorMeta = z.infer<typeof ErrorMetaSchema>;
export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const PrioritySchema = z.enum(["high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;
