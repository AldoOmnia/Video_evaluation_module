/**
 * Simulated procedure session generator.
 *
 * Walks the KeySteps in order, emitting a small number of correct events
 * per step plus optional anomalies drawn from that step's errorProfile
 * weighted by priority bucket.
 *
 * This is the same generator the brain-eval-lab.html ships inline; the
 * shared form is here so both the in-browser eval and the backend's
 * batch runner produce identical session shapes.
 */
import type { ProcedureSpec } from "../../shared/types/procedure.js";
import type { SessionEvent } from "../../shared/types/events.js";
import type { ErrorCode, Priority } from "../../shared/types/taxonomy.js";

export interface GenerateOptions {
  anomalyRate?: number; // 0..1, default 0.4
  seed?: number;
}

export function generateSimulatedSession(
  procedure: ProcedureSpec,
  opts: GenerateOptions = {},
): SessionEvent[] {
  const rate = opts.anomalyRate ?? 0.4;
  const rnd = mulberry32(opts.seed ?? Date.now() & 0xffffffff);
  const events: SessionEvent[] = [];
  let t = 0;

  const sorted = [...procedure.keysteps].sort((a, b) => a.order - b.order);
  for (const step of sorted) {
    const stepDuration = 30 + rnd() * 60;
    const stepEnd = t + stepDuration;
    // 1-2 "correct" beats per step
    const beats = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < beats; i++) {
      t += stepDuration / (beats + 1);
      events.push({
        ts: round1(t),
        phase: step.label,
        stepId: step.id,
        label: "correct",
      });
    }
    // Maybe inject one anomaly somewhere in the step
    if (rnd() < rate) {
      const drawn = drawAnomaly(step.errorProfile, rnd);
      if (drawn) {
        t = Math.min(stepEnd - 1, t + 1 + rnd() * 4);
        events.push({
          ts: round1(t),
          phase: step.label,
          stepId: step.id,
          label: "incorrect",
          errorType: drawn.code,
          priority: drawn.priority,
        });
      }
    }
    t = stepEnd;
  }
  return events;
}

function drawAnomaly(
  profile: {
    high_priority: ErrorCode[];
    medium_priority: ErrorCode[];
    low_priority: ErrorCode[];
  },
  rnd: () => number,
): { code: ErrorCode; priority: Priority } | null {
  // Weights: high 50%, medium 35%, low 15% — but only when bucket non-empty.
  const allBuckets: Array<[Priority, ErrorCode[], number]> = [
    ["high", profile.high_priority ?? [], 0.5],
    ["medium", profile.medium_priority ?? [], 0.35],
    ["low", profile.low_priority ?? [], 0.15],
  ];
  const buckets = allBuckets.filter((b) => b[1].length > 0);
  if (buckets.length === 0) return null;
  const totalW = buckets.reduce((a, b) => a + b[2], 0);
  let pick = rnd() * totalW;
  for (const [pri, codes, w] of buckets) {
    if ((pick -= w) <= 0)
      return { code: codes[Math.floor(rnd() * codes.length)], priority: pri };
  }
  const last = buckets.at(-1)!;
  return {
    code: last[1][Math.floor(rnd() * last[1].length)],
    priority: last[0],
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
