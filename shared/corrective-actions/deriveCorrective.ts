/**
 * Procedure-grounded corrective actions for eval + on-glass lens ACTION lines.
 *
 * Priority order:
 *   1. Step instructions (instr:NN) — official work instruction text
 *   2. Expert advice (advice:NN) — shop-floor tribal knowledge in the spec
 *   3. Taxonomy templates — error-code specific Comer defaults
 *   4. LLM `fix` field — contextual nuance from the live eval call
 *
 * The lab panel shows the full `fix` (≤140 chars). The lens ACTION line is
 * always a short imperative derived from the same sources, then fit to display.
 */
import type { KeyStep, ProcedureSpec } from "../types/procedure.js";
import type { ErrorCode } from "../types/taxonomy.js";

export type CorrectiveSourceKind =
  | "instruction"
  | "expert_advice"
  | "taxonomy"
  | "llm";

export interface CorrectiveSource {
  id: string;
  kind: CorrectiveSourceKind;
  text: string;
}

export interface DerivedCorrective {
  /** Full sentence for lab / modal (not lens-truncated). */
  fix: string;
  /** Short imperative for AnswerCard ACTION line (pre display-fit). */
  lensAction: string;
  fixSources: CorrectiveSource[];
  actionSources: CorrectiveSource[];
}

/** Pinion Guide defaults — aligned with shared/error-taxonomy/taxonomy.yaml examples. */
const TAXONOMY_FIX: Partial<
  Record<ErrorCode, { fix: string; action: string }>
> = {
  SUBSTITUTION: {
    fix: "Remove wrong part; match SKU to traveler exactly — do not substitute.",
    action: "Check SKU vs traveler",
  },
  ORIENTATION: {
    fix: "Re-orient per work instruction; chamfer must face inboard before press.",
    action: "Flip 180° · re-seat",
  },
  OMITTED_OBJECT: {
    fix: "Bring required tool/part to the station before continuing this step.",
    action: "Get required part/tool",
  },
  OUT_OF_SPEC: {
    fix: "Measurement out of range — stop and rework per acceptance criteria.",
    action: "Re-measure · do not advance",
  },
  UNVERIFIED: {
    fix: "Required check was skipped — take the reading/sign-off before proceeding.",
    action: "Take reading now",
  },
  INCOMPLETE: {
    fix: "Step not fully completed — finish all passes/checks before advancing.",
    action: "Finish step fully",
  },
  ORDER: {
    fix: "Steps out of sequence — return to the missed step in procedure order.",
    action: "Return to prior step",
  },
  OMISSION: {
    fix: "Required step was skipped — perform it before continuing.",
    action: "Perform missed step",
  },
};

export function stepReferences(procedure: ProcedureSpec, stepId: string) {
  return {
    instructions: procedure.instructions.filter((i) => i.forStep === stepId),
    advice: procedure.expertAdvice.filter((a) => a.forStep === stepId),
  };
}

/** Build the AUTHORITATIVE CORRECTIVES block injected into the eval LLM user message. */
export function formatCorrectiveContext(
  procedure: ProcedureSpec,
  step: KeyStep,
  errorCode?: ErrorCode | null,
): string {
  const { instructions, advice } = stepReferences(procedure, step.id);
  const lines: string[] = [];
  for (const i of instructions) {
    lines.push(`  ${i.id}: ${i.label}`);
  }
  for (const a of advice) {
    lines.push(`  ${a.id}: ${a.label} (${a.source})`);
  }
  const hint = errorCode ? TAXONOMY_FIX[errorCode] : undefined;
  if (hint) {
    lines.push(`  taxonomy/${errorCode}: ${hint.fix}`);
  }
  if (lines.length === 0) return "  (none listed — use step acceptance criteria only)";
  return lines.join("\n");
}

export function shortenToAction(text: string, max = 36): string {
  const s = text
    .replace(/^stop\s*[—–-]\s*/i, "")
    .replace(/^please\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const vs = s.match(/\bvs\.?\s+(.+)$/i);
  if (vs && `vs ${vs[1]}`.length <= max) {
    const head = s.slice(0, s.length - vs[0].length).trim();
    const headBudget = max - vs[0].length - 1;
    if (headBudget >= 6) {
      const headWords = head.split(" ");
      let line = "";
      for (const w of headWords) {
        if (!line) line = w;
        else if (line.length + 1 + w.length <= headBudget) line += ` ${w}`;
        else break;
      }
      const combined = `${line} ${vs[0].trim()}`.trim();
      return combined.length <= max ? combined : vs[0].trim().slice(0, max);
    }
    return vs[0].trim().slice(0, max);
  }
  const first = s.split(/[.;]/)[0]?.trim() ?? s;
  if (first.length <= max) return first;
  return first.slice(0, Math.max(1, max - 1)) + "…";
}

export function deriveCorrective(
  procedure: ProcedureSpec,
  step: KeyStep,
  errorCode: ErrorCode | null | undefined,
  llm: {
    fix?: string;
    diagnosis?: string;
    errorCode?: ErrorCode | null;
    detected?: boolean;
  },
): DerivedCorrective {
  const fixSources: CorrectiveSource[] = [];
  const actionSources: CorrectiveSource[] = [];
  const { instructions, advice } = stepReferences(procedure, step.id);
  const code = errorCode ?? llm.errorCode ?? null;

  let procedureFix = "";
  let procedureAction = "";

  for (const instr of instructions) {
    fixSources.push({ id: instr.id, kind: "instruction", text: instr.label });
    if (!procedureFix && /verify|check|match|orient|zero|apply|hand-/i.test(instr.label)) {
      procedureFix = instr.label;
      procedureAction = shortenToAction(instr.label);
      actionSources.push({
        id: instr.id,
        kind: "instruction",
        text: procedureAction,
      });
    }
  }

  for (const adv of advice) {
    fixSources.push({ id: adv.id, kind: "expert_advice", text: adv.label });
    const snippet = adv.label.split(/[.—]/)[0]?.trim() ?? adv.label;
    if (!procedureFix && /must|do not|never|exactly|reject|restart/i.test(adv.label)) {
      procedureFix = snippet;
      if (!procedureAction) {
        procedureAction = shortenToAction(snippet);
        actionSources.push({
          id: adv.id,
          kind: "expert_advice",
          text: procedureAction,
        });
      }
    }
  }

  if (code && TAXONOMY_FIX[code]) {
    const hint = TAXONOMY_FIX[code]!;
    fixSources.push({ id: code, kind: "taxonomy", text: hint.fix });
    if (!procedureAction) {
      procedureAction = hint.action;
      actionSources.push({ id: code, kind: "taxonomy", text: hint.action });
    }
    if (!procedureFix) procedureFix = hint.fix;
  }

  const llmFix = (llm.fix ?? "").trim();
  if (llmFix) {
    fixSources.push({ id: "llm:fix", kind: "llm", text: llmFix });
  }

  const fix =
    llmFix ||
    procedureFix ||
    (llm.diagnosis ? llm.diagnosis.split(/[—.;]/)[0]?.trim() : "") ||
    (llm.detected ? "Review step and correct per SOP before advancing." : "");

  let lensAction = procedureAction || shortenToAction(llmFix) || "";
  if (!lensAction && llm.detected) {
    lensAction = shortenToAction(procedureFix) || "Correct per SOP";
    if (procedureFix) {
      actionSources.push({
        id: "derived",
        kind: "instruction",
        text: lensAction,
      });
    }
  }

  return {
    fix: fix.slice(0, 240),
    lensAction,
    fixSources,
    actionSources,
  };
}
