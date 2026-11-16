#!/usr/bin/env node
/**
 * Regression cover for the glasses guards as replayed in the digital twin.
 *
 * backend/src/services/glassesGuard.ts is a port of WrongPartGuard.kt and
 * SequenceGuard.kt. The preview is only worth looking at if a card goes up
 * and comes down where the glasses would put it, so each case below is a
 * behaviour the Kotlin source documents, most of them from a measured failure
 * on the line: a correctly held part must not flash a card, a flipped one must
 * not flicker, and a card must not outlive the mistake.
 *
 *   npx tsx tools/test-glasses-guard.mjs
 */
import { replayGuards, guardClasses, glassesSpec } from "../backend/src/services/glassesGuard.ts";

const W = glassesSpec().wrongPartGuard;
const CONE = "67190R91";
const FLIP = "67190R91-FLIP";

/** A read. `scene` is what else the frame lists. */
const read = (t, sku, confidence, className = "bearing cone", scene = []) => ({ t, sku, confidence, className, scene });
const hands = (t, scene = [], confidence = 0.9) => ({ t, sku: null, confidence, className: "hands_only", scene });

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}
/** The card's history as "raise@t headline" and "clear@t code". */
const story = (r) =>
  r.events.map((e) => (e.kind === "raise" ? `raise@${e.t} ${e.warning.headline}` : `clear@${e.t} ${e.code}`));
const codes = (r) => r.reads.map((x) => x.code);

// ── Orientation: raising ───────────────────────────────────────────────────

check(
  "one strong flipped read, no correct read near it, raises at once",
  story(replayGuards(6, [read(0, FLIP, 0.95)], 1)),
  ["raise@0 WRONG ORIENTATION"],
);

check(
  "a strong flipped read right after a correct one is held back as oscillation",
  codes(replayGuards(6, [read(0, CONE, 0.95), read(1.7, FLIP, 0.95)], 2)),
  ["expected", "decoy_wait"],
);

check(
  "and is confirmed by a second flipped read",
  story(replayGuards(6, [read(0, CONE, 0.95), read(1.7, FLIP, 0.95), read(3.4, FLIP, 0.95)], 4)),
  ["raise@3.4 WRONG ORIENTATION"],
);

check(
  "a correct read older than the oscillation window does not hold a strong flip back",
  story(replayGuards(6, [read(0, CONE, 0.95), read(2.5, FLIP, 0.95)], 3)),
  ["raise@2.5 WRONG ORIENTATION"],
);

check(
  "two ordinary flipped reads in a row raise",
  story(replayGuards(6, [read(0, FLIP, 0.8), read(1.7, FLIP, 0.8)], 2)),
  ["raise@1.7 WRONG ORIENTATION"],
);

check(
  "a flipped read below the floor counts for nothing",
  story(replayGuards(6, [read(0, FLIP, 0.6), read(1.7, FLIP, 0.6), read(3.4, FLIP, 0.6)], 4)),
  [],
);

check(
  "an undecided frame between two flipped reads restarts the count",
  story(replayGuards(6, [read(0, FLIP, 0.8), read(1.7, null, 0.4), read(3.4, FLIP, 0.8)], 4)),
  [],
);

check(
  "unless that frame still lists the part: the hold is not broken",
  story(replayGuards(6, [read(0, FLIP, 0.8), hands(1.7, ["bearing cone"]), read(3.4, FLIP, 0.8)], 4)),
  ["raise@3.4 WRONG ORIENTATION"],
);

// ── Orientation: clearing ──────────────────────────────────────────────────

const up = [read(0, FLIP, 0.95)];

check(
  "one strong correct read does not drop the card, two do",
  story(replayGuards(6, [...up, read(1.7, CONE, 0.95), read(3.4, CONE, 0.95)], 4)),
  ["raise@0 WRONG ORIENTATION", "clear@3.4 cleared_corrected"],
);

check(
  "a flipped read between two correct ones restarts the clear",
  story(replayGuards(6, [...up, read(1.7, CONE, 0.95), read(3.4, FLIP, 0.95), read(5.1, CONE, 0.95)], 6)),
  ["raise@0 WRONG ORIENTATION"],
);

check(
  "correct reads under the strong bar hold the card however many there are",
  story(replayGuards(6, [...up, read(1.7, CONE, 0.85), read(3.4, CONE, 0.85), read(5.1, CONE, 0.85)], 6)),
  ["raise@0 WRONG ORIENTATION"],
);

check(
  "empty hands with the part still listed in the frame keep the card",
  story(replayGuards(6, [...up, hands(1.7, ["bearing cone", "glove"]), hands(3.4, ["bearing cone"])], 4)),
  ["raise@0 WRONG ORIENTATION"],
);

check(
  "empty hands with nothing listed leave it to the time-out",
  codes(replayGuards(6, [...up, hands(1.7, [])], 2)),
  ["raised_instant", "hands_noscene"],
);

check(
  "empty hands with a scene that no longer has the part clear it",
  story(replayGuards(6, [...up, hands(1.7, ["bench", "fixture"])], 2)),
  ["raise@0 WRONG ORIENTATION", "clear@1.7 cleared_hands_left"],
);

check(
  "an orientation card unseen for the long time-out comes down by itself",
  story(replayGuards(6, up, 30)),
  ["raise@0 WRONG ORIENTATION", `clear@${W.STICKY_DECOY_ABSENCE_MS / 1000} absent`],
);

check(
  "and stays up when the replay ends before the time-out",
  story(replayGuards(6, up, 5)),
  ["raise@0 WRONG ORIENTATION"],
);

// ── What the card says ─────────────────────────────────────────────────────

const card = replayGuards(6, up, 1).events[0].warning;
check("the card shows the real part number, never the flip identity", card.detail, `Bearing cone (${CONE})`);
check(
  "its action is the step's own decoy text",
  card.action,
  glassesSpec().steps.find((s) => s.n === 6).decoys[0].action,
);

// ── A part from another step ───────────────────────────────────────────────

const foreignRun = replayGuards(6, [read(0, "248114A1", 0.95, "bearing cup"), read(1.7, "248114A1", 0.95, "bearing cup")], 2);
check("another step's part never raises on one read, and does on two", story(foreignRun), ["raise@1.7 WRONG PART"]);
check("it is told to go back", foreignRun.events[0].warning.action, "Not for step 6 - put it back");
check(
  "and the card clears as soon as the right part is in hand",
  story(
    replayGuards(6, [read(0, "248114A1", 0.9, "bearing cup"), read(1.7, "248114A1", 0.9, "bearing cup"), read(3.4, CONE, 0.9)], 4),
  ),
  ["raise@1.7 WRONG PART", "clear@3.4 cleared_swapped"],
);

check(
  "the two look-alike retainer rings never raise as another step's part",
  story(replayGuards(1, [0, 1.7, 3.4].map((t) => read(t, "92203637", 0.95, "retainer ring")), 4)),
  [],
);

// ── The built-in decoy and the wrong driver ────────────────────────────────

check(
  "the C-ring picked up from nothing raises on one read at the pickup bar",
  story(replayGuards(7, [read(0, "229515A2", 0.93, "c-ring")], 1)),
  ["raise@0 WRONG PART"],
);

check(
  "straight after a held ring it needs the stronger bar or a second read",
  codes(replayGuards(7, [read(0, "92203637", 0.9, "retainer ring"), read(1.7, "229515A2", 0.93, "c-ring")], 2)),
  ["expected", "decoy_wait"],
);

check(
  "it clears on empty hands, with no scene needed",
  story(replayGuards(7, [read(0, "229515A2", 0.96, "c-ring"), hands(1.7)], 2)),
  ["raise@0 WRONG PART", "clear@1.7 cleared_hands"],
);

check(
  "and after the short time-out when it is simply gone",
  story(replayGuards(7, [read(0, "229515A2", 0.96, "c-ring")], 30)),
  ["raise@0 WRONG PART", `clear@${W.WRONG_PART_ABSENCE_MS / 1000} absent`],
);

check(
  "the wrong driver at step 8 raises and clears on the right one",
  story(
    replayGuards(
      8,
      [read(0, "3187.111.100.28", 0.8, "driver"), read(1.7, "3187.111.100.28", 0.8, "driver"), read(3.4, "3187.111.100.27", 0.9, "driver")],
      4,
    ),
  ),
  ["raise@1.7 WRONG DRIVER", "clear@3.4 cleared_correct"],
);

// ── Pick order ─────────────────────────────────────────────────────────────

const orderRun = replayGuards(
  7,
  [
    read(0, "191713A1", 0.9, "spacer retainer"),
    read(1.7, "191713A1", 0.9, "spacer retainer"),
    read(3.4, "92203637", 0.9, "retainer ring"),
    read(5.1, "92203637", 0.9, "retainer ring"),
  ],
  6,
);
check("the last part of the pack picked first raises the order card", story(orderRun), [
  "raise@1.7 CHECK ORDER",
  "clear@5.1 slot_done",
]);
check("naming what was picked and what goes first", [orderRun.events[0].warning.detail, orderRun.events[0].warning.action], [
  "thin spacer retainer before thick spacer retainer",
  "Thick spacer retainer goes on first",
]);

check(
  "the pack picked in order raises nothing",
  story(
    replayGuards(
      7,
      ["92203637", "92203637", "191711A1", "191711A1", "191713A1", "191713A1"].map((sku, i) => read(i * 1.7, sku, 0.9, "ring")),
      12,
    ),
  ),
  [],
);

// ── Where the guards do not run ────────────────────────────────────────────

check("a step that lists no parts is not guarded", replayGuards(3, [read(0, FLIP, 0.99)], 1), {
  guarded: false,
  events: [],
  reads: [],
});
check("and has nothing to list", guardClasses(3), []);
check(
  "step 6 can raise its flip, the built-in decoy and another step's part",
  guardClasses(6).map((c) => `${c.kind}:${c.headline}`),
  ["orientation:WRONG ORIENTATION", "builtin:WRONG PART", "foreign:WRONG PART"],
);
check(
  "step 7 adds the pick order",
  guardClasses(7).map((c) => c.kind),
  ["builtin", "foreign", "order"],
);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
