/**
 * Procedural memory FSM — Layer 2 of the 5-layer agent loop.
 *
 * Tracks: which KeyStep is the worker in, transitions, time-in-step.
 * Fuses three signals (priority order):
 *   1. OEM signal (when available)
 *   2. CV detections matching this step's expected tools/parts
 *   3. Dwell timer (forward-progress assumption)
 *
 * Pure reducer style so the eval lab can replay event streams deterministically
 * and the Rokid APK can host the same state machine in Kotlin via codegen.
 */
import type { ProcedureSpec, KeyStep } from "../types/procedure";

export interface FsmState {
  currentStepId: string;
  enteredAt: number;
  dwellMs: number;
  history: { stepId: string; enteredAt: number; leftAt?: number }[];
  /** Tracking which expected items have been observed in current step. */
  observedRequirements: { tools: Set<string>; parts: Set<string> };
  oemReportedStep?: string;
  oemTs?: number;
}

export interface FsmInput {
  ts: number;
  /** CV detections {tool/part id → confidence}. */
  detections?: Record<string, number>;
  oemSignal?: { reportedStep: string; ts: number };
}

export function initFsm(procedure: ProcedureSpec, t0 = 0): FsmState {
  const first = [...procedure.keysteps].sort((a, b) => a.order - b.order)[0];
  return {
    currentStepId: first.id,
    enteredAt: t0,
    dwellMs: 0,
    history: [{ stepId: first.id, enteredAt: t0 }],
    observedRequirements: { tools: new Set(), parts: new Set() },
  };
}

export function stepFsm(
  state: FsmState,
  input: FsmInput,
  procedure: ProcedureSpec,
): FsmState {
  const next: FsmState = {
    ...state,
    observedRequirements: {
      tools: new Set(state.observedRequirements.tools),
      parts: new Set(state.observedRequirements.parts),
    },
    history: state.history.slice(),
    dwellMs: input.ts - state.enteredAt,
    oemReportedStep: input.oemSignal?.reportedStep ?? state.oemReportedStep,
    oemTs: input.oemSignal?.ts ?? state.oemTs,
  };

  const requirements = procedure.stepRequirements[state.currentStepId] ?? {
    tools: [],
    parts: [],
  };
  for (const [id, conf] of Object.entries(input.detections ?? {})) {
    if (conf < 0.6) continue;
    if (requirements.tools.includes(id))
      next.observedRequirements.tools.add(id);
    if (requirements.parts.includes(id))
      next.observedRequirements.parts.add(id);
  }

  // Advance: OEM trumps everything if fresh (<5s)
  if (
    input.oemSignal &&
    input.oemSignal.reportedStep !== state.currentStepId &&
    input.ts - input.oemSignal.ts < 5
  ) {
    return advanceTo(next, input.oemSignal.reportedStep, input.ts);
  }

  // CV satisfied for current step + dwell > step's risk-tuned threshold?
  const stepDone =
    requirements.tools.every((t) => next.observedRequirements.tools.has(t)) &&
    requirements.parts.every((p) => next.observedRequirements.parts.has(p));
  const minDwell = riskDwellMs(currentKeyStep(procedure, state.currentStepId));
  if (stepDone && next.dwellMs >= minDwell) {
    const nextStep = nextStepId(procedure, state.currentStepId);
    if (nextStep) return advanceTo(next, nextStep, input.ts);
  }

  return next;
}

function advanceTo(state: FsmState, toStep: string, ts: number): FsmState {
  const lastIdx = state.history.length - 1;
  const updated = state.history.slice();
  updated[lastIdx] = { ...updated[lastIdx], leftAt: ts };
  updated.push({ stepId: toStep, enteredAt: ts });
  return {
    ...state,
    currentStepId: toStep,
    enteredAt: ts,
    dwellMs: 0,
    history: updated,
    observedRequirements: { tools: new Set(), parts: new Set() },
  };
}

function nextStepId(procedure: ProcedureSpec, current: string): string | null {
  const sorted = [...procedure.keysteps].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((s) => s.id === current);
  return idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1].id : null;
}

export function currentKeyStep(procedure: ProcedureSpec, id: string): KeyStep {
  const k = procedure.keysteps.find((s) => s.id === id);
  if (!k) throw new Error(`Unknown step: ${id}`);
  return k;
}

function riskDwellMs(step: KeyStep): number {
  switch (step.risk) {
    case "high":
      return 8_000;
    case "med":
      return 4_000;
    case "low":
    default:
      return 2_000;
  }
}
