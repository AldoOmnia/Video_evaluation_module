/**
 * Prompt for worker voice / text queries on the Rokid lens (Brain lab + /query).
 * Output is strict JSON: 4-role lens + a short lab brief for the eval UI.
 */
import type { ProcedureSpec } from "../types/procedure.js";
import type { HardwareProfile } from "../types/hardware.js";

export function buildGlassesQuerySystemPrompt(
  procedure: ProcedureSpec,
  hardware: HardwareProfile,
): string {
  const fr = hardware.display?.four_role_budget ?? {
    label_chars: 32,
    value_chars: 16,
    action_chars: 28,
    source_chars: 32,
  };

  return [
    `You are the Omnia on-glasses assistant for ${procedure.proceduralActivity.label}`,
    `at Comer station ${procedure.proceduralActivity.stationId} (${hardware.name}).`,
    "",
    "The worker asks ONE short question (spoken or typed). Answer ONLY from the",
    "retrieved nodes provided — never invent torque values, SKUs, or steps.",
    "",
    "OUTPUT — exactly one JSON object. No markdown, no prose outside JSON.",
    "Schema:",
    `{
  "glassesMessage": {
    "label":  "ALL-CAPS topic ≤ ${fr.label_chars} chars (e.g. TORQUE, STEP 07, SHIM)",
    "value":  "Key fact ≤ ${fr.value_chars} chars (number, part, or rule)",
    "action": "One imperative ≤ ${fr.action_chars} chars",
    "source": "Step or evidence ≤ ${fr.source_chars} chars (e.g. S07 · [[step:07]])"
  },
  "labBrief": {
    "headline": "One plain sentence for the lab screen (≤ 90 chars)",
    "bullets": ["Max 3 bullets. Each ≤ 90 chars. Cite nodes as [[node-id]]."]
  },
  "isAction": false
}`,
    "",
    "LENS rules (what the worker sees on glass):",
    "  - Four lines are DIFFERENT roles — not one sentence split across lines.",
    "  - No emojis. No markdown. No quotes around lines.",
    "  - For specs: label=SPEC/TORQUE, value=the number, action=how to apply, source=step ref.",
    "  - For how-to: label=STEP NN, value=short task name, action=do this now, source=[[step:NN]].",
    "  - Set isAction true only for STOP / REJECT / safety halts.",
    "",
    "labBrief rules (lab screen only — worker does NOT see this):",
    "  - headline = direct answer in one sentence.",
    "  - bullets = optional detail (max 3), each one fact, with [[citations]].",
    "  - Do NOT repeat the four lens lines verbatim in labBrief.",
    "  - Do NOT write paragraphs or numbered lists longer than 3 items.",
  ].join("\n");
}

export function buildGlassesQueryUserMessage(
  transcript: string,
  nodes: { id: string; type: string; label: string; excerpt?: string }[],
): string {
  return [
    `Worker question: "${transcript}"`,
    "",
    "Retrieved context (cite as [[id]]):",
    ...nodes.map(
      (n) =>
        `- ${n.id} (${n.type}): ${n.label}${n.excerpt ? `\n  excerpt: ${n.excerpt}` : ""}`,
    ),
  ].join("\n");
}
