/**
 * The two guards that decide what the Comer glasses put on their panel,
 * replayed over a list of reads.
 *
 * On the glasses a read (one answer from the observe call: a part, a pose, a
 * confidence) never reaches the operator directly. WrongPartGuard and
 * SequenceGuard watch the stream of reads and raise or clear one shared
 * warning card. This file is those two classes in TypeScript, branch for
 * branch, so that a clip played in the digital twin shows the card going up
 * and coming down where the glasses would have put it.
 *
 * Nothing here is tuned locally. The steps, parts, decoys, pick order and
 * every threshold come from shared/data/glasses-guards-st100.json, which
 * tools/sync-glasses-guards.mjs copies out of the glasses repo. The branch
 * letters in the comments below are the ones in WrongPartGuard.kt, so the two
 * can be read side by side.
 *
 * What differs from the device, and cannot be otherwise:
 *  - Time is the clip's, not a wall clock. A card is raised at the time of
 *    the frame that raised it; on the glasses it lands one round trip later.
 *  - The device re-checks its time-outs on a one second heartbeat, so a
 *    time-out there lands up to a second after the moment computed here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SHARED_DIR } from "../paths.js";

export interface GuardDecoy {
  sku: string;
  /** Set when the decoy is the SAME part in the wrong pose (an orientation
   *  decoy). Null for a different object, such as the wrong press driver. */
  decoyFor: string | null;
  headline: string;
  action: string;
  description: string;
}
export interface GuardStep {
  n: number;
  title: string;
  detail: string;
  lookFor: string;
  parts: Array<{ sku: string; description: string }>;
  decoys: GuardDecoy[];
  pickSequence: Array<{ label: string; skus: string[] }>;
}
export interface GlassesSpec {
  _source: {
    repo: string;
    ref: string;
    commit: string;
    files: Record<string, { path: string; lastChanged: string }>;
    copiedOn: string;
    by: string;
  };
  procedure: { id: string; title: string };
  steps: GuardStep[];
  wrongPartGuard: {
    builtInDecoys: string[];
    indistinguishable: string[];
    WRONG_PART_CONSECUTIVE: number;
    WRONG_PART_MIN_CONF: number;
    INSTANT_DECOY_CONF: number;
    INSTANT_DECOY_STRONG_CONF: number;
    ORIENTATION_INSTANT_CONF: number;
    ORIENTATION_OSCILLATION_MS: number;
    HANDS_EMPTY_MIN_CONF: number;
    WRONG_PART_ABSENCE_MS: number;
    STICKY_DECOY_ABSENCE_MS: number;
    CORRECT_CLEAR_STRONG_CONF: number;
    CORRECT_CLEAR_CONSECUTIVE: number;
    HEARTBEAT_MS: number;
    MAX_DETAIL_CHARS: number;
  };
  sequenceGuard: { SEQ_MIN_CONF: number; SEQ_CONSECUTIVE: number; SEQ_ABSENCE_MS: number };
  memory: { recentObservationWindowMs: number };
  observe: { model: string; fallbackModel: string; cadenceMs: number; cadenceSamples: number };
}

let specCache: GlassesSpec | null = null;

/** What the glasses warn about and when, as copied from their repo. */
export function glassesSpec(): GlassesSpec {
  if (!specCache) {
    specCache = JSON.parse(
      readFileSync(join(SHARED_DIR, "data", "glasses-guards-st100.json"), "utf8"),
    ) as GlassesSpec;
  }
  return specCache;
}

const FLIP_SUFFIX = "-FLIP";
const HANDS_ONLY_CLASS = "hands_only";

/** The real part behind a pose identity: `248118A1-FLIP` → `248118A1`. */
export function baseSku(sku: string): string {
  const u = sku.trim().toUpperCase();
  return u.endsWith(FLIP_SUFFIX) ? u.slice(0, -FLIP_SUFFIX.length) : u;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && a.toUpperCase() === b.toUpperCase();

function normalizeClass(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function friendlyName(rawClassName: string, maxChars: number): string {
  const cleaned = rawClassName.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "This part";
  const capped = cleaned.length <= maxChars ? cleaned : cleaned.slice(0, maxChars - 1).trimEnd() + "\u2026";
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/* ── What a step can warn about ─────────────────────────────────────────── */

export type ClassKind = "orientation" | "decoy" | "builtin" | "foreign" | "order";

export interface GuardClass {
  /** Stable within a step; a raised card names the class it came from. */
  id: string;
  kind: ClassKind;
  headline: string;
  action: string;
  /** The SKUs whose read raises this class. */
  skus: string[];
  /** The part number the card shows the operator. Null where it depends on
   *  the part that was read (a part from another step). */
  shownSku: string | null;
  /** For a pick order: the slots, first to last. */
  slots?: Array<{ label: string; skus: string[] }>;
}

function stepOf(n: number): GuardStep | null {
  return glassesSpec().steps.find((s) => s.n === n) ?? null;
}

/** Parts another step of the procedure owns: holding one here is a pick
 *  error. The look-alike retainer rings are left out, as on the glasses,
 *  because a held frame cannot tell them apart. */
function foreignParts(step: GuardStep): Set<string> {
  const spec = glassesSpec();
  const own = new Set(step.parts.map((p) => baseSku(p.sku)));
  const skip = new Set(spec.wrongPartGuard.indistinguishable.map((s) => s.toUpperCase()));
  const out = new Set<string>();
  for (const s of spec.steps) {
    for (const p of s.parts) {
      const b = baseSku(p.sku);
      if (b && !own.has(b) && !skip.has(b)) out.add(b);
    }
  }
  return out;
}

/**
 * The warnings the glasses can raise at a step, read off the same data the
 * guards run on. A step that lists no parts has none: both guards stand down
 * there, so the list is empty rather than a row of things that cannot fire.
 */
export function guardClasses(n: number): GuardClass[] {
  const step = stepOf(n);
  if (!step || !step.parts.length) return [];
  const spec = glassesSpec();
  const notForStep = `Not for step ${step.n} - put it back`;
  const out: GuardClass[] = [];

  for (const d of step.decoys) {
    out.push({
      id: `decoy:${d.sku.toUpperCase()}`,
      kind: d.decoyFor ? "orientation" : "decoy",
      headline: d.headline || "WRONG PART",
      action: d.action || notForStep,
      skus: [d.sku],
      shownSku: d.decoyFor || d.sku,
    });
  }
  const stepDecoys = new Set(step.decoys.map((d) => d.sku.toUpperCase()));
  for (const sku of spec.wrongPartGuard.builtInDecoys) {
    if (stepDecoys.has(sku.toUpperCase())) continue;
    out.push({
      id: `decoy:${sku.toUpperCase()}`,
      kind: "builtin",
      headline: "WRONG PART",
      action: notForStep,
      skus: [sku],
      shownSku: sku,
    });
  }
  const foreign = [...foreignParts(step)];
  if (foreign.length) {
    out.push({
      id: "foreign",
      kind: "foreign",
      headline: "WRONG PART",
      action: notForStep,
      skus: foreign,
      shownSku: null,
    });
  }
  if (step.pickSequence.length) {
    out.push({
      id: "order",
      kind: "order",
      headline: "CHECK ORDER",
      action: "",
      skus: step.pickSequence.flatMap((g) => g.skus),
      shownSku: null,
      slots: step.pickSequence,
    });
  }
  return out;
}

/* ── Replay ─────────────────────────────────────────────────────────────── */

/** One read, as the guards see it. */
export interface Observation {
  /** Seconds into the clip. */
  t: number;
  /** As the observe call reports it: a part number, its `-FLIP` identity when
   *  the pose is wrong, or null when no catalogue part is the subject. */
  sku: string | null;
  className: string;
  confidence: number;
  /** Other things the read lists in the frame. */
  scene: string[];
}

export interface PanelWarning {
  source: "wrong_part" | "sequence";
  classId: string;
  headline: string;
  detail: string;
  action: string;
  /** What was read. Never shown to the operator when it is a `-FLIP` id. */
  sku: string;
}

/** Why a guard did what it did with a read. Codes rather than sentences so
 *  the page can say them in the reader's language. */
export type ReadCode =
  | "expected"
  | "expected_strong"
  | "expected_weak"
  | "expected_hold"
  | "cleared_corrected"
  | "cleared_correct"
  | "cleared_swapped"
  | "decoy_wait"
  | "raised_instant"
  | "raised_consecutive"
  | "already_up"
  | "foreign_wait"
  | "raised_foreign"
  | "other_part"
  | "hands_empty"
  | "hands_keep"
  | "hands_noscene"
  | "cleared_hands"
  | "cleared_hands_left"
  | "ambiguous";

export type OrderCode = "slot_wait" | "slot_done" | "order_wait" | "raised_order" | "order_deferred" | "seq_complete" | "slot_seen";

export interface ReadNote {
  t: number;
  /** The branch of WrongPartGuard.kt that handled the read. */
  branch: "a" | "b" | "b''" | "b'" | "c" | "d";
  code: ReadCode;
  /** Count towards a threshold, where the code has one: n of `of`. */
  n?: number;
  of?: number;
  /** A correct read sat inside the oscillation window, so one strong wrong
   *  read was not enough. */
  correctNearby?: boolean;
  order?: { code: OrderCode; slot?: number; n?: number; of?: number };
  /** Headline on the card once this read has been handled. */
  showing: string | null;
}

export interface PanelEvent {
  t: number;
  kind: "raise" | "clear";
  source: "wrong_part" | "sequence";
  warning: PanelWarning | null;
  code: ReadCode | OrderCode | "absent";
}

export interface GuardReplay {
  /** False when the step lists no parts: neither guard runs there. */
  guarded: boolean;
  events: PanelEvent[];
  reads: ReadNote[];
}

/**
 * Run both guards over `observations` at step `n`, up to `endT` seconds.
 *
 * WrongPartGuard handles each read first and SequenceGuard second. On the
 * glasses the two listen to the same event independently; the order only
 * matters when both would raise off one read, and there the device gives the
 * wrong-part card the slot whichever ran first, because the order guard
 * refuses to raise over it.
 */
export function replayGuards(n: number, observations: Observation[], endT: number): GuardReplay {
  const spec = glassesSpec();
  const step = stepOf(n);
  if (!step || !step.parts.length) return { guarded: false, events: [], reads: [] };

  const W = spec.wrongPartGuard;
  const S = spec.sequenceGuard;
  const ms = (t: number) => Math.round(t * 1000);

  const expected = step.parts.map((p) => p.sku);
  const stepDecoys = new Map(step.decoys.map((d) => [d.sku.toUpperCase(), d]));
  const decoySet = new Set([...W.builtInDecoys.map((s) => s.toUpperCase()), ...stepDecoys.keys()]);
  const orientationDecoys = new Set(
    [...stepDecoys.values()].filter((d) => d.decoyFor).map((d) => d.sku.toUpperCase()),
  );
  const foreign = foreignParts(step);
  const sequence = step.pickSequence;

  const events: PanelEvent[] = [];
  const reads: ReadNote[] = [];

  // The one card both guards share.
  let active: PanelWarning | null = null;

  // WrongPartGuard state. Times are clip milliseconds; null is "never", where
  // the device holds 0 against a wall clock.
  let candidateSku: string | null = null;
  let candidateClassName: string | null = null;
  let consecutiveWrong = 0;
  let consecutiveCorrect = 0;
  let lastWrongObservedAt: number | null = null;
  let lastHeldNonDecoyAt: number | null = null;
  let lastExpectedSkuSeenAt: number | null = null;
  let activeWarningClassName: string | null = null;

  // SequenceGuard state.
  const satisfied = new Set<number>();
  let streakGroupIdx = -1;
  let streakCount = 0;
  let lastViolationSeenAt: number | null = null;

  const resetCandidate = () => {
    candidateSku = null;
    candidateClassName = null;
    consecutiveWrong = 0;
  };

  /** Each guard clears only its own card. */
  function clearWrongPart(at: number, code: PanelEvent["code"]): void {
    activeWarningClassName = null;
    if (!active || active.source !== "wrong_part") return;
    events.push({ t: at / 1000, kind: "clear", source: "wrong_part", warning: null, code });
    active = null;
  }
  function clearOrder(at: number, code: PanelEvent["code"]): void {
    if (!active || active.source !== "sequence") return;
    events.push({ t: at / 1000, kind: "clear", source: "sequence", warning: null, code });
    active = null;
  }

  function raiseWrongPart(
    o: Observation,
    sku: string,
    decoy: { decoyFor: string | null; headline: string; action: string } | null,
    classId: string,
    code: ReadCode,
  ): boolean {
    if (active && same(active.sku, sku)) return false; // already up
    const shown = decoy?.decoyFor || sku;
    active = {
      source: "wrong_part",
      classId,
      headline: decoy?.headline || "WRONG PART",
      detail: `${friendlyName(o.className, W.MAX_DETAIL_CHARS)} (${shown})`,
      action: decoy?.action || `Not for step ${step!.n} - put it back`,
      sku,
    };
    activeWarningClassName = o.className;
    events.push({ t: o.t, kind: "raise", source: "wrong_part", warning: active, code });
    return true;
  }

  function candidateStillInScene(o: Observation): boolean {
    if (candidateSku == null) return false;
    const cand = normalizeClass(candidateClassName);
    if (!cand) return false;
    return o.scene.some((s) => {
      const c = normalizeClass(s);
      return c.length > 0 && (c.includes(cand) || cand.includes(c));
    });
  }

  /** (e) and SequenceGuard's absence fallback: a card whose part has not been
   *  seen for its time-out comes down, whether or not a new read arrived. */
  function timeouts(now: number): void {
    if (active?.source === "wrong_part" && lastWrongObservedAt != null) {
      const ttl = orientationDecoys.has(active.sku.toUpperCase())
        ? W.STICKY_DECOY_ABSENCE_MS
        : W.WRONG_PART_ABSENCE_MS;
      if (now - lastWrongObservedAt > ttl) {
        const at = lastWrongObservedAt + ttl;
        resetCandidate();
        clearWrongPart(at, "absent");
      }
    }
    if (active?.source === "sequence" && lastViolationSeenAt != null) {
      if (now - lastViolationSeenAt > S.SEQ_ABSENCE_MS) {
        clearOrder(lastViolationSeenAt + S.SEQ_ABSENCE_MS, "absent");
      }
    }
  }

  function wrongPart(o: Observation): Omit<ReadNote, "t" | "showing" | "order"> {
    const at = ms(o.t);
    const cls = o.className.toLowerCase();
    const conf = o.confidence;
    const sku = o.sku && o.sku.trim() ? o.sku.trim() : null;
    const confidentSku = sku != null && conf >= W.WRONG_PART_MIN_CONF;
    const expectedSkuInView = confidentSku && expected.some((e) => same(e, sku));

    // a) The step's own part is in the frame.
    if (expectedSkuInView) {
      resetCandidate();
      lastHeldNonDecoyAt = at;
      lastExpectedSkuSeenAt = at;
      if (active) {
        const activeDecoy = stepDecoys.get(active.sku.toUpperCase());
        if (activeDecoy?.decoyFor) {
          // An orientation card stays up until the part is turned over, and a
          // single correct read is exactly what a still-flipped part produces
          // now and then. Only strong correct reads count, and it takes a run.
          if (conf >= W.CORRECT_CLEAR_STRONG_CONF) {
            consecutiveCorrect += 1;
            if (consecutiveCorrect >= W.CORRECT_CLEAR_CONSECUTIVE) {
              clearWrongPart(at, "cleared_corrected");
              return { branch: "a", code: "cleared_corrected", n: consecutiveCorrect, of: W.CORRECT_CLEAR_CONSECUTIVE };
            }
            return { branch: "a", code: "expected_strong", n: consecutiveCorrect, of: W.CORRECT_CLEAR_CONSECUTIVE };
          }
          return { branch: "a", code: "expected_weak" };
        }
        if (activeDecoy) {
          clearWrongPart(at, "cleared_correct");
          return { branch: "a", code: "cleared_correct" };
        }
        if (active.source === "wrong_part" && foreign.has(baseSku(active.sku))) {
          clearWrongPart(at, "cleared_swapped");
          return { branch: "a", code: "cleared_swapped" };
        }
        // The built-in decoy holds until it is out of view, and an order card
        // is not this guard's to clear.
        return { branch: "a", code: "expected_hold" };
      }
      consecutiveCorrect = 0;
      return { branch: "a", code: "expected" };
    }

    // b) A decoy for this step: debounce, or raise on one strong read.
    if (confidentSku && decoySet.has(sku!.toUpperCase())) {
      consecutiveCorrect = 0;
      if (same(sku, candidateSku)) consecutiveWrong += 1;
      else {
        candidateSku = sku;
        consecutiveWrong = 1;
      }
      candidateClassName = o.className;
      lastWrongObservedAt = at;

      const cameFromHeldRing =
        lastHeldNonDecoyAt != null && at - lastHeldNonDecoyAt <= spec.memory.recentObservationWindowMs;
      const isOrientationDecoy = orientationDecoys.has(sku!.toUpperCase());
      const correctReadNearby =
        lastExpectedSkuSeenAt != null && at - lastExpectedSkuSeenAt <= W.ORIENTATION_OSCILLATION_MS;
      const instantRaise = isOrientationDecoy
        ? conf >= W.ORIENTATION_INSTANT_CONF && !correctReadNearby
        : conf >= W.INSTANT_DECOY_STRONG_CONF || (!cameFromHeldRing && conf >= W.INSTANT_DECOY_CONF);

      if (instantRaise || consecutiveWrong >= W.WRONG_PART_CONSECUTIVE) {
        const code: ReadCode = instantRaise ? "raised_instant" : "raised_consecutive";
        const raised = raiseWrongPart(o, sku!, stepDecoys.get(sku!.toUpperCase()) ?? null, `decoy:${sku!.toUpperCase()}`, code);
        return { branch: "b", code: raised ? code : "already_up", n: consecutiveWrong, of: W.WRONG_PART_CONSECUTIVE };
      }
      // The card for this part is already up: the count restarted (a correct
      // read came between) but there is nothing left to raise.
      if (active && same(active.sku, sku)) return { branch: "b", code: "already_up" };
      return {
        branch: "b",
        code: "decoy_wait",
        n: consecutiveWrong,
        of: W.WRONG_PART_CONSECUTIVE,
        correctNearby: isOrientationDecoy && correctReadNearby && conf >= W.ORIENTATION_INSTANT_CONF,
      };
    }

    // b'') A part another step owns: always debounced, never on one read.
    if (confidentSku && foreign.has(baseSku(sku!))) {
      consecutiveCorrect = 0;
      if (same(sku, candidateSku)) consecutiveWrong += 1;
      else {
        candidateSku = sku;
        consecutiveWrong = 1;
      }
      candidateClassName = o.className;
      lastWrongObservedAt = at;
      if (consecutiveWrong >= W.WRONG_PART_CONSECUTIVE) {
        const raised = raiseWrongPart(
          o,
          sku!,
          { decoyFor: baseSku(sku!), headline: "WRONG PART", action: "" },
          "foreign",
          "raised_foreign",
        );
        return { branch: "b''", code: raised ? "raised_foreign" : "already_up", n: consecutiveWrong, of: W.WRONG_PART_CONSECUTIVE };
      }
      return { branch: "b''", code: "foreign_wait", n: consecutiveWrong, of: W.WRONG_PART_CONSECUTIVE };
    }

    // b') Some other confident part that no rule names: harmless by design.
    if (confidentSku) {
      resetCandidate();
      consecutiveCorrect = 0;
      lastHeldNonDecoyAt = at;
      return { branch: "b'", code: "other_part" };
    }

    // c) Confident empty hands.
    if (cls === HANDS_ONLY_CLASS && conf >= W.HANDS_EMPTY_MIN_CONF) {
      if (!active) {
        // A read of empty hands that still lists the pending part is a blink
        // in the middle of a hold, so the count towards a raise is kept.
        if (!candidateStillInScene(o)) resetCandidate();
        return { branch: "c", code: "hands_empty" };
      }
      resetCandidate();
      if (orientationDecoys.has(active.sku.toUpperCase())) {
        const warned = normalizeClass(activeWarningClassName);
        const stillInScene =
          warned.length > 0 &&
          o.scene.some((s) => {
            const c = normalizeClass(s);
            return c.includes(warned) || warned.includes(c);
          });
        if (stillInScene) {
          lastWrongObservedAt = at;
          return { branch: "c", code: "hands_keep" };
        }
        // No scene list is no evidence either way: the time-out decides.
        if (!o.scene.length) return { branch: "c", code: "hands_noscene" };
        clearWrongPart(at, "cleared_hands_left");
        return { branch: "c", code: "cleared_hands_left" };
      }
      if (active.source !== "wrong_part") return { branch: "c", code: "hands_empty" };
      clearWrongPart(at, "cleared_hands");
      return { branch: "c", code: "cleared_hands" };
    }

    // d) Low confidence, or not a catalogue part.
    if (!candidateStillInScene(o)) resetCandidate();
    return { branch: "d", code: "ambiguous" };
  }

  function order(o: Observation): ReadNote["order"] {
    if (!sequence.length) return undefined;
    const at = ms(o.t);
    const sku = o.sku && o.sku.trim() ? o.sku.trim() : null;
    if (sku == null || o.confidence < S.SEQ_MIN_CONF) {
      streakGroupIdx = -1;
      streakCount = 0;
      return undefined;
    }
    const groupIdx = sequence.findIndex((g) => g.skus.some((s) => same(s, sku)));
    if (groupIdx < 0) {
      // Not a part of the pack: WrongPartGuard's business. Break the run so
      // two separate sightings cannot be bridged by frames of something else.
      streakGroupIdx = -1;
      streakCount = 0;
      return undefined;
    }
    if (groupIdx === streakGroupIdx) streakCount += 1;
    else {
      streakGroupIdx = groupIdx;
      streakCount = 1;
    }
    let nextIdx = -1;
    for (let i = 0; i < sequence.length; i++) {
      if (!satisfied.has(i)) { nextIdx = i; break; }
    }
    if (nextIdx < 0) {
      clearOrder(at, "seq_complete");
      return { code: "seq_complete" };
    }
    if (groupIdx === nextIdx) {
      if (streakCount >= S.SEQ_CONSECUTIVE) {
        satisfied.add(groupIdx);
        clearOrder(at, "slot_done");
        return { code: "slot_done", slot: groupIdx + 1 };
      }
      return { code: "slot_wait", slot: groupIdx + 1, n: streakCount, of: S.SEQ_CONSECUTIVE };
    }
    if (groupIdx > nextIdx && !satisfied.has(groupIdx)) {
      lastViolationSeenAt = at;
      if (streakCount < S.SEQ_CONSECUTIVE) {
        return { code: "order_wait", slot: groupIdx + 1, n: streakCount, of: S.SEQ_CONSECUTIVE };
      }
      // A part that does not belong at all is the worse problem: the order
      // card never goes up over it.
      if (active && active.source !== "sequence") return { code: "order_deferred", slot: groupIdx + 1 };
      const picked = sequence[groupIdx];
      const wanted = sequence[nextIdx];
      const pickedLabel = picked.label || picked.skus[0] || "this part";
      const wantedLabel = wanted.label || wanted.skus[0] || "the earlier part";
      if (active && active.detail.includes(pickedLabel)) return { code: "raised_order", slot: groupIdx + 1 };
      active = {
        source: "sequence",
        classId: "order",
        headline: "CHECK ORDER",
        detail: `${pickedLabel} before ${wantedLabel}`,
        action: `${wantedLabel.charAt(0).toUpperCase()}${wantedLabel.slice(1)} goes on first`,
        sku: picked.skus[0] ?? "",
      };
      events.push({ t: o.t, kind: "raise", source: "sequence", warning: active, code: "raised_order" });
      return { code: "raised_order", slot: groupIdx + 1 };
    }
    // A slot already filled, seen again: the part lying in view, or a re-pick.
    return { code: "slot_seen", slot: groupIdx + 1 };
  }

  const ordered = [...observations].sort((a, b) => a.t - b.t);
  for (const o of ordered) {
    timeouts(ms(o.t));
    const note = wrongPart(o);
    const orderNote = order(o);
    // TypeScript narrows `active` to null across the closures above.
    const showing = (active as PanelWarning | null)?.headline ?? null;
    reads.push({ t: o.t, ...note, order: orderNote, showing });
  }
  timeouts(ms(endT));

  events.sort((a, b) => a.t - b.t);
  return { guarded: true, events, reads };
}
