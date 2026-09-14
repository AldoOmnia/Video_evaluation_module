/**
 * POST /api/pov/reason — AI reasoner for POV clips added in the digital twin.
 *
 * The built-in station walkthrough is pre-annotated offline
 * (scripts/annotate-pov.mjs) because it never changes. Clips the user drops
 * into the viewer have no cached timeline, so this endpoint produces one on
 * demand: the browser samples frames, this route judges them against the
 * glasses reference library, and the viewer replays the verdicts over the
 * video.
 *
 * The question these clips ask is narrower than the walkthrough's "which step
 * is this": they show a part held up to the camera, correctly or wrong-side-up,
 * and the answer has to be the same one the glasses would reach — hence the
 * shared reference vocabulary (correct-orientation photos AND the -FLIP
 * decoys) and the same primary→fallback vision models.
 *
 * All frames go in ONE call. Per-frame calls would re-upload ~1MB of
 * references for every frame, and a model that sees the whole clip at once
 * keeps its part identification consistent across it — the same reason the
 * offline script's neighbour smoothing exists.
 */
import { Router } from "express";
import { z } from "zod";

import { geminiVisionCall, geminiConfigured, VISION_MODEL, type GeminiPart } from "../services/gemini.js";
import {
  referenceLibrary,
  referenceParts,
  rawBase64,
  parseJsonish,
  resolveFlipSku,
  ORIENTATION_RULES,
} from "../services/componentVision.js";
import { GLASSES_COMPONENTS, findGlassesComponent } from "./kb.js";

export const povRouter = Router();

/** Frames per request. The browser samples to fit; more than this stops
 *  earning its latency, since a held-part clip is a handful of seconds. */
const MAX_FRAMES = 12;

const FrameSchema = z.object({
  t: z.number().min(0).max(36_000),
  dataBase64: z.string().min(8).max(1_500_000), // ~1.1MB binary per frame
  mimeType: z.string().max(60).optional(),
});
const BodySchema = z.object({
  clip: z.string().max(200).default("clip"),
  frames: z.array(FrameSchema).min(1).max(MAX_FRAMES),
  lang: z.enum(["en", "it"]).optional(),
  /** Which part the clip is of, when the reviewer knows. See buildPrompt. */
  expectSku: z.string().max(40).optional(),
});

/** What the model is asked to return per frame, before KB grounding. */
interface RawFrame {
  i: number;
  caption: string;
  sku: string | null;
  className: string;
  orientation: "correct" | "wrong" | "unclear";
  confidence: number;
  reasoning: string;
}

type Verdict = "ok" | "wrong" | "unclear" | "none";

interface ReasonedFrame {
  t: number;
  caption: string;
  sku: string | null;
  /** KB display name when the SKU is known, else the model's description. */
  component: string;
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  /** The orientation rule from the KB — the glasses' own overlay copy. */
  expected: string | null;
  /** Headline the glasses would show, when a warning is actually wired. */
  warning: string | null;
  /** False when the part has no orientation warning wired on the glasses,
   *  so the viewer can say "recognised, but nothing would fire". */
  wouldFire: boolean;
  steps: string[];
}

/** The look-alike pairs, and why naming the wrong member is so costly: each
 *  pair runs the OPPOSITE orientation convention, so a mis-identification does
 *  not merely mislabel the part, it inverts the verdict. */
const PAIRS: Record<string, string> = {
  "248118A1": "67190R91",
  "67190R91": "248118A1",
  "248114A1": "191440A1",
  "191440A1": "248114A1",
};

/** Narrow a clip to one part when the reviewer already knows which it is.
 *
 *  This is how the glasses actually work: the observe loop runs inside a step,
 *  so "which of the two cones is this" is answered by the procedure, never by
 *  vision — step 4 expects 248118A1, step 6 expects 67190R91. Asking vision to
 *  choose between a pair unaided is a harder problem than the device ever
 *  poses, and one it demonstrably loses: cage-up views of the two cones are
 *  near-identical, and with no scale in frame the model settles on the more
 *  heavily referenced 248118A1 at high confidence. Because the conventions are
 *  opposite, that single error flips a wrong verdict to correct — the failure
 *  mode worth engineering out.
 */
function expectClause(expectSku: string): string {
  const other = PAIRS[expectSku];
  const name = GLASSES_COMPONENTS[expectSku]?.name ?? expectSku;
  return (
    `\n\nPART IS KNOWN — this clip is of ${expectSku} (${name}), the way the ` +
    "glasses know it from the current step. Do NOT re-derive identity: return " +
    `${expectSku} (or ${expectSku}-FLIP) on every frame where the part is ` +
    "visible, and spend your judgment on ORIENTATION alone, applying that " +
    "part's own rule above." +
    (other
      ? ` ${other} has been withheld from your references for this clip: it is ` +
        "the look-alike this part is most often confused with, it runs the " +
        "OPPOSITE convention, and naming it would invert the verdict."
      : "") +
    " If a frame plainly shows some other part, say so in reasoning and set " +
    "orientation 'unclear' rather than forcing the expected part onto it.\n" +
    // Pinning removes one question; it must not license answering another one
    // the rules forbid. Measured here: with the part pinned, a correctly-held
    // small cup filmed at the fixture came back FLIP at 0.95 on every frame
    // where the operator tilted it towards edge-on — poses the cup rule says
    // carry no orientation information at all.
    "Knowing the part settles IDENTITY ONLY. Every orientation rule above still " +
    "applies in full — including the side / edge-on prohibitions and the " +
    "default-to-correct bias. Do NOT manufacture a verdict for a pose those " +
    "rules say cannot be judged: a cup seen edge-on or tilted steeply enough " +
    "that its up-face is not clearly a wide bright band or a narrow flat ring " +
    "is 'unclear', NEVER -FLIP, exactly as on the glasses.\n"
  );
}

function buildPrompt(lang?: "en" | "it", expectSku?: string): string {
  return (
    "You are the AI reasoner for the Comer Industries digital twin, reviewing a " +
    "short point-of-view clip from station ST.100 (pinion cover pre-assembly). " +
    "In these clips an operator holds a part up to the camera, either in its " +
    "CORRECT orientation or deliberately wrong-side-up, to test whether the " +
    "system catches it.\n\n" +
    "The REFERENCE images below are your vocabulary — the same set the " +
    "smart-glasses observe loop uses. Each is labeled with its part number and " +
    "whether it shows the correct orientation or the FLIPPED decoy. Judge the " +
    "clip frames against them.\n\n" +
    "For EVERY frame I give you, decide:\n" +
    "  - sku: the part number from the references, or null if no part is clearly " +
    "visible. Report wrong-side-up the way the glasses do, by returning that " +
    "part's -FLIP class (e.g. 67190R91-FLIP) — the rules below are written in " +
    "those terms. Judge orientation whether the part is held up, resting on the " +
    "bench or already seated in a fixture: which face points up is the question.\n" +
    "  - orientation: 'correct', 'wrong', or 'unclear' when the angle genuinely " +
    "cannot settle it. Must agree with the sku you returned.\n" +
    "  - caption: ONE short present-tense sentence describing what the frame shows.\n" +
    "  - reasoning: the distinguishing feature you used, ≤12 words " +
    '(e.g. "flat ring face up, TIMKEN visible"). Long sentences truncate the ' +
    "JSON and the frame is lost.\n" +
    "  - confidence: 0-1 for the orientation judgment.\n\n" +
    "Be conservative and consistent: it is the same part across most of a clip, " +
    "so do not change identification between frames unless the part visibly " +
    "changes.\n\n" +
    // The rules the device applies, verbatim from its observe prompt. Any
    // divergence here shows up as the platform contradicting the glasses about
    // the same part in the same orientation.
    "ORIENTATION RULES — these are the rules the glasses themselves apply, and " +
    "your verdict must match what the device would say:\n" +
    ORIENTATION_RULES.join("\n") +
    "\n" +
    // The rules name several poses that carry no orientation information. An
    // operator turning a part over spends real frames in exactly those poses,
    // and a model asked to rule on every frame will invent verdicts for them —
    // measured here as confident -FLIP calls on a correctly-held cup tilting
    // towards edge-on. Abstention has to be stated as a valid answer.
    "Do NOT manufacture a verdict for a pose the rules above say cannot be " +
    "judged. An operator rotating a part passes through such poses on the way, " +
    "and 'unclear' is the correct answer for those frames — not a guess in " +
    "either direction.\n\n" +
    "IDENTITY BEFORE ORIENTATION — never infer WHICH part it is from which face " +
    "is up. The catalogue fingerprints say things like 'roller cage up = this " +
    "correct identity'; those phrases separate a part from its OWN flipped decoy " +
    "and must NEVER be used to choose between the two cones or the two cups. " +
    "Because each pair runs the opposite convention, the traps are exact: a " +
    "FLIPPED 67190R91 shows its roller cage up, precisely like a CORRECT " +
    "248118A1, and a FLIPPED 248114A1 shows a bare bright raceway up, precisely " +
    "like a CORRECT 191440A1. Mis-naming the pair member therefore inverts the " +
    "verdict rather than merely mislabelling the part.\n" +
    "Settling a pair needs SCALE — there is no shape giveaway, since cage-up " +
    "views of the two cones genuinely resemble each other. Use whatever is in " +
    "frame as a ruler: the gloved hand, the fixture pocket, a bin label. " +
    "67190R91 is about 82mm across, roughly a palm's width, against a markedly " +
    "larger 248118A1; 191440A1 is about 140mm OD with a narrow stamped band, " +
    "against a larger 248114A1 with a broad one.\n\n" +
    (expectSku && GLASSES_COMPONENTS[expectSku] ? expectClause(expectSku) + "\n" : "") +
    'Answer ONLY with raw JSON: {"frames": [{"i": number, "caption": string, ' +
    '"sku": string|null, "className": string, "orientation": ' +
    '"correct"|"wrong"|"unclear", "confidence": number, "reasoning": string}]} ' +
    "with one entry per frame, in order." +
    (lang === "it"
      ? " The user's interface is ITALIAN: write caption, className and reasoning in Italian (keep part numbers and proper nouns unchanged)."
      : "")
  );
}

/** Attach what the knowledge base knows about the part the model named. */
function ground(raw: RawFrame, t: number): ReasonedFrame {
  const { sku, flipDecoy } = resolveFlipSku(raw.sku);
  const cfg = sku ? GLASSES_COMPONENTS[sku] : undefined;
  const kbComp = sku ? findGlassesComponent(sku) : null;
  const orientation = flipDecoy ? "wrong" : raw.orientation;

  // Only claim a warning where the glasses actually wire one. A part can be
  // recognised, and visibly upside-down, and still fire nothing — the shim
  // pack carries an ORDER guard, not an orientation guard — and saying
  // otherwise would promise coverage the device does not have.
  const wouldFire = Boolean(cfg?.codes.includes("ORIENTATION"));
  const warning = kbComp?.warning ?? cfg?.warning ?? null;

  let verdict: Verdict;
  if (!sku) verdict = "none";
  else if (orientation === "wrong") verdict = "wrong";
  else if (orientation === "correct") verdict = "ok";
  else verdict = "unclear";

  return {
    t,
    caption: raw.caption.slice(0, 240),
    sku,
    component: kbComp?.name ?? cfg?.name ?? raw.className.slice(0, 120),
    verdict,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    reasoning: raw.reasoning.slice(0, 240),
    // The action text IS the orientation rule ("flat stamped face must face
    // up"), which is exactly what a reviewer wants next to a wrong verdict.
    expected: warning?.action ?? null,
    warning: verdict === "wrong" && wouldFire ? (warning?.headline ?? "WRONG ORIENTATION") : null,
    wouldFire,
    steps: kbComp?.steps ?? [],
  };
}

/**
 * The device's raise condition, ported from WrongPartGuard.kt
 * (comer-rokid-demo, constants retuned on site 2026-09-12 against a measured
 * 1678ms observe cadence).
 *
 * A clip verdict used to be "any frame read wrong at ≥0.5", which is far more
 * trigger-happy than the glasses and made the summary hostage to single-frame
 * model variance: the same ten frames of a correctly-held cup came back `ok`
 * on one run and `wrong` on the next, off one 0.9 frame mid-rotation. The
 * device never behaved that way, because a warning has to survive a debounce
 * before it reaches the HUD.
 *
 * Reproducing that here is the whole point of the eval module — the clip
 * summary should answer "would the glasses have fired on this", not "did any
 * frame look wrong to Gemini once".
 *
 * Raise when EITHER:
 *   - one wrong read at ≥0.92 with no confident correct read of the same part
 *     within the previous 2s (an adjacent correct read means the pose is
 *     oscillating, which on a correctly-held part is exactly what it does), OR
 *   - two consecutive confident wrong reads.
 */
const GUARD = {
  /** Floor for a read to count at all (WRONG_PART_MIN_CONF). */
  MIN_CONF: 0.7,
  /** Single-frame raise (ORIENTATION_INSTANT_CONF). */
  INSTANT_CONF: 0.92,
  /** Confident wrong frames to confirm (WRONG_PART_CONSECUTIVE). */
  CONSECUTIVE: 2,
  /** Oscillation window in clip seconds (ORIENTATION_OSCILLATION_MS). */
  OSCILLATION_S: 2.0,
};

interface GuardOutcome {
  raised: boolean;
  via: "instant" | "consecutive" | null;
  /** Why confident wrong reads did NOT reach a warning, when they existed. */
  suppressed: "oscillation" | "unconfirmed" | null;
  atT: number | null;
}

function deviceRaise(frames: ReasonedFrame[]): GuardOutcome {
  let consecutive = 0;
  let lastCorrectT: number | null = null;
  let sawWrong = false;
  let suppressed: GuardOutcome["suppressed"] = null;

  for (const f of frames) {
    const confident = f.confidence >= GUARD.MIN_CONF;
    if (f.verdict === "ok" && confident) {
      lastCorrectT = f.t;
      consecutive = 0;
      continue;
    }
    if (f.verdict !== "wrong" || !confident) {
      // Unclear, absent or low-confidence breaks the run. Stricter than the
      // device, which only resets on a correct read or confirmed empty hands,
      // and stricter in the safe direction: a false WRONG ORIENTATION on a
      // good part is the expensive error.
      consecutive = 0;
      continue;
    }
    sawWrong = true;
    consecutive += 1;
    const oscillating = lastCorrectT !== null && f.t - lastCorrectT <= GUARD.OSCILLATION_S;
    if (f.confidence >= GUARD.INSTANT_CONF && !oscillating) {
      return { raised: true, via: "instant", suppressed: null, atT: f.t };
    }
    if (consecutive >= GUARD.CONSECUTIVE) {
      return { raised: true, via: "consecutive", suppressed: null, atT: f.t };
    }
    suppressed = oscillating ? "oscillation" : "unconfirmed";
  }
  return { raised: false, via: null, suppressed: sawWrong ? suppressed ?? "unconfirmed" : null, atT: null };
}

povRouter.post("/reason", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const refs = referenceLibrary();

    if (!geminiConfigured()) {
      return res.json({
        clip: body.clip,
        stubbed: true,
        model: "stub",
        latencyMs: 0,
        note: `Vision stub — set GEMINI_API_KEY to run ${VISION_MODEL} against the ${refs.length} glasses reference images.`,
        frames: [],
      });
    }

    const expectSku = body.expectSku ? resolveFlipSku(body.expectSku).sku : null;
    // Narrowed to the pinned part's family, dropping the look-alike it would
    // otherwise be free to answer with — the lever that actually moved the
    // numbers on device, where prompt wording alone did not.
    const refParts = referenceParts({ scopeSku: expectSku ?? undefined });
    const parts: GeminiPart[] = [
      { text: buildPrompt(body.lang, expectSku ?? undefined) },
      ...refParts,
    ];
    // One text part + one image part per reference, so the attached count is
    // half the parts — worth reporting accurately, since the whole point of
    // scoping is that this number goes down.
    const attachedRefs = refParts.length / 2;
    body.frames.forEach((f, i) => {
      parts.push({ text: `FRAME i=${i} at t=${f.t.toFixed(1)}s of the clip:` });
      parts.push({
        inline_data: { mime_type: f.mimeType || "image/jpeg", data: rawBase64(f.dataBase64) },
      });
    });

    const out = await geminiVisionCall(parts, {
      route: "pov-reason",
      // ~110 tokens of JSON per frame, plus headroom for Italian.
      maxOutputTokens: 260 + body.frames.length * 170,
      // A dozen frames on top of the reference library is a much bigger
      // request than a single-photo identification.
      timeoutMs: 60_000,
    });

    const parsed = parseJsonish<{ frames: RawFrame[] }>(out.text);
    const rawFrames = Array.isArray(parsed.frames) ? parsed.frames : [];
    const byIndex = new Map<number, RawFrame>();
    rawFrames.forEach((f, pos) => {
      const i = Number.isInteger(f?.i) ? Number(f.i) : pos;
      if (i >= 0 && i < body.frames.length) byIndex.set(i, f);
    });

    const frames: ReasonedFrame[] = body.frames.map((f, i) => {
      const r = byIndex.get(i);
      return ground(
        {
          i,
          caption: String(r?.caption ?? ""),
          sku: (r?.sku ?? null) as string | null,
          className: String(r?.className ?? ""),
          orientation:
            r?.orientation === "correct" || r?.orientation === "wrong" ? r.orientation : "unclear",
          confidence: Number(r?.confidence ?? 0),
          reasoning: String(r?.reasoning ?? ""),
        },
        f.t,
      );
    });

    // Clip-level roll-up: what a reviewer wants to read before scrubbing.
    const wrong = frames.filter((f) => f.verdict === "wrong");
    const ok = frames.filter((f) => f.verdict === "ok");
    const guard = deviceRaise(frames);
    const skus = [...new Set(frames.map((f) => f.sku).filter(Boolean))] as string[];

    res.json({
      clip: body.clip,
      stubbed: false,
      model: out.model,
      latencyMs: out.latencyMs,
      references: attachedRefs,
      frames,
      summary: {
        skus,
        component: frames.find((f) => f.sku)?.component ?? null,
        wrongFrames: wrong.length,
        okFrames: ok.length,
        // The clip reads "wrong" when the glasses' own guard would have raised
        // over these frames — not merely when one frame looked wrong.
        verdict: guard.raised ? "wrong" : ok.length ? "ok" : "unclear",
        wouldFire:
          guard.raised &&
          wrong.some((f) => f.wouldFire && f.confidence >= GUARD.MIN_CONF),
        // How the device got there, so a reviewer can tell a confirmed catch
        // from a single high-confidence frame — and can see when confident
        // wrong reads were deliberately suppressed as pose oscillation.
        guard: {
          raised: guard.raised,
          via: guard.via,
          suppressed: guard.suppressed,
          atT: guard.atT,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});
