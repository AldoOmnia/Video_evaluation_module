/**
 * Tier-1 deterministic rule evaluator — Layer 3 of the agent loop.
 *
 * Runs every 2-5s on-device. Cheap, predictable, no LLM. If it fires it
 * escalates to Tier-2 (the LLM, via prompt-assembly).
 *
 * This module captures the rules that DON'T need a language model:
 *   - tool/part presence checks
 *   - acceptance-criteria parsing (numeric ranges, "≤ X" style)
 *   - sequence violations (out of step order)
 *
 * The eval lab uses this to score strategy A4 (tiered proactive). The
 * Rokid APK invokes it on a 2-5s tick.
 */
import type { ProcedureSpec, KeyStep } from "../types/procedure";
import type { ErrorCode } from "../types/taxonomy";
import type { FsmState } from "../fsm/proceduralMemory";

export interface RuleVerdict {
  fired: boolean;
  errorCode?: ErrorCode;
  rationale: string;
  /** Whether the agent should escalate to Tier-2 LLM. */
  escalate: boolean;
}

export function evaluateRules(
  fsm: FsmState,
  step: KeyStep,
  detections: Record<string, number>,
  procedure: ProcedureSpec,
  now: number,
): RuleVerdict {
  const req = procedure.stepRequirements[step.id] ?? { tools: [], parts: [] };

  // Rule R1 — required part missing after enough dwell.
  const dwellSec = (now - fsm.enteredAt);
  if (dwellSec > 5) {
    for (const partId of req.parts) {
      if (!fsm.observedRequirements.parts.has(partId)) {
        return {
          fired: true,
          errorCode: "OMITTED_OBJECT",
          rationale: `Required part ${partId} not seen after ${dwellSec.toFixed(0)}s in ${step.id}.`,
          escalate: true,
        };
      }
    }
  }

  // Rule R2 — extra object detected that's not in this step's requirements
  // and is a known tool/part class (i.e. not just background).
  const knownIds = new Set([
    ...procedure.tools.map((t) => t.id),
    ...procedure.parts.map((p) => p.id),
  ]);
  for (const [id, conf] of Object.entries(detections)) {
    if (conf < 0.7) continue;
    if (!knownIds.has(id)) continue;
    const allowed =
      req.tools.includes(id) ||
      req.parts.includes(id) ||
      isAllowedFromAdjacentStep(id, step, procedure);
    if (!allowed) {
      return {
        fired: true,
        errorCode: "EXTRA_OBJECT",
        rationale: `Unexpected ${id} present during ${step.id}.`,
        escalate: true,
      };
    }
  }

  // Rule R3 — OEM disagreement (Group D)
  if (fsm.oemReportedStep && fsm.oemReportedStep !== step.id) {
    return {
      fired: true,
      errorCode: "INTENT_MISMATCH",
      rationale: `OEM says ${fsm.oemReportedStep} but FSM at ${step.id}.`,
      escalate: true,
    };
  }

  // Rule R4 — acceptance number out of band (parsed from acceptance string)
  const numericBand = parseAcceptance(step.acceptance);
  if (numericBand && detections[`measure:${step.id}`] != null) {
    const v = detections[`measure:${step.id}`];
    if (v < numericBand.min || v > numericBand.max) {
      return {
        fired: true,
        errorCode: "OUT_OF_SPEC",
        rationale: `Measured ${v} outside ${numericBand.min}-${numericBand.max}.`,
        escalate: true,
      };
    }
  }

  return { fired: false, rationale: "ok", escalate: false };
}

function isAllowedFromAdjacentStep(
  id: string,
  step: KeyStep,
  procedure: ProcedureSpec,
): boolean {
  const sorted = [...procedure.keysteps].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((s) => s.id === step.id);
  for (const off of [-1, 1]) {
    const adj = sorted[idx + off];
    if (!adj) continue;
    const r = procedure.stepRequirements[adj.id];
    if (r && (r.tools.includes(id) || r.parts.includes(id))) return true;
  }
  return false;
}

/** Parse "8-12 kN", "210-240 Nm", "≤ 0.015mm" etc. into {min,max}. */
export function parseAcceptance(s: string): { min: number; max: number } | null {
  const range = s.match(/(-?\d+(\.\d+)?)\s*-\s*(-?\d+(\.\d+)?)/);
  if (range) return { min: parseFloat(range[1]), max: parseFloat(range[3]) };
  const le = s.match(/[≤<]=?\s*(-?\d+(\.\d+)?)/);
  if (le) return { min: -Infinity, max: parseFloat(le[1]) };
  const ge = s.match(/[≥>]=?\s*(-?\d+(\.\d+)?)/);
  if (ge) return { min: parseFloat(ge[1]), max: Infinity };
  return null;
}
