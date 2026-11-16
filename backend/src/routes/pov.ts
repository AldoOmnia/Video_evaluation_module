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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { EVAL_LAB_PUBLIC, SHARED_DIR } from "../paths.js";

import { geminiVisionCall, geminiConfigured, VISION_MODEL, type GeminiPart } from "../services/gemini.js";
import {
  referenceLibrary,
  referenceParts,
  vocabularySkus,
  rawBase64,
  parseJsonish,
  resolveFlipSku,
  ORIENTATION_RULES,
} from "../services/componentVision.js";
import {
  glassesSpec,
  guardClasses,
  replayGuards,
  baseSku,
  type GuardStep,
  type Observation,
} from "../services/glassesGuard.js";
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

/** Frames used to settle identity. Enough to find one with the hand or the
 *  fixture in shot, few enough that the extra call stays cheap. */
const ID_FRAMES = 5;

interface ClipIdentity {
  sku: string | null;
  alternative: string | null;
  confidence: number;
  reasoning: string;
}

/**
 * Decide WHICH part a clip is of, once, before judging any orientation.
 *
 * Without this the reasoner answers identity and orientation together on every
 * frame, and for the look-alike pairs that goes wrong in the one way that
 * matters: the pairs run OPPOSITE conventions, so a mis-identification does not
 * mislabel the part, it inverts the verdict. Unpinned clips of the step-6 cone
 * came back named as the step-4 cone — the more heavily referenced class — with
 * the verdict flipped to match.
 *
 * Two things make this pass better at identity than the per-frame pass:
 *
 *  - It pools the whole clip. Scale is the only cue that separates a pair, and
 *    it is present in some frames and absent in others; a per-frame decision
 *    re-litigates identity on frames that cannot support one, while an operator
 *    turning a part over will bring it past the fixture at least once.
 *  - Orientation is explicitly not its job, so it cannot reach for "which face
 *    is up" as an identity cue — the circular reasoning the catalogue
 *    fingerprints invite, since they describe each part's correct pose.
 *
 * Its answer then scopes the orientation pass exactly as a manual pin does,
 * withholding the look-alike from the vocabulary. That narrowing is the lever
 * the glasses measured as effective where prompt wording alone was not.
 */
async function identifyClip(
  frames: Array<{ t: number; dataBase64: string; mimeType?: string }>,
  lang?: "en" | "it",
): Promise<ClipIdentity> {
  const step = Math.max(1, Math.floor(frames.length / ID_FRAMES));
  const picked = frames.filter((_, i) => i % step === 0).slice(0, ID_FRAMES);

  const prompt =
    "You are identifying ONE part for the Comer Industries digital twin, from a " +
    "short point-of-view clip shot at station ST.100. Every frame below is the " +
    "SAME part, held or placed by an operator.\n\n" +
    "Your ONLY job is to say WHICH part it is. Do NOT judge orientation, and do " +
    "NOT let orientation influence identity — the reference notes describe each " +
    "part's correct pose, so 'which face is up' says nothing about which part " +
    "you are looking at.\n\n" +
    "Pool evidence across ALL the frames rather than deciding from one. Two " +
    "pairs in this vocabulary are separated mainly by SIZE, and size can only " +
    "be judged against something known:\n" +
    "  - the CONES 248118A1 (step 4, larger) and 67190R91 (step 6, ~82mm, about " +
    "a palm's width)\n" +
    "  - the CUPS 248114A1 (step 1, larger, broad stamped rim) and 191440A1 " +
    "(step 2, ~140mm OD, narrow stamped band)\n" +
    "Use any frame that shows the part against a gloved hand, the fixture " +
    "pocket, the bench or a bin label as your ruler, and carry that conclusion " +
    "to the frames that have no scale cue. A part that fills the frame is not " +
    "necessarily large.\n\n" +
    "Also use shape family: a CUP is a plain outer race ring with no rollers; a " +
    "CONE carries a visible roller cage; a RETAINER RING shows two through-holes " +
    "~180 degrees apart. A legible stamped part number overrides everything.\n\n" +
    'Answer ONLY with raw JSON: {"sku": string|null, "alternative": string|null, ' +
    '"confidence": number, "reasoning": string}. `alternative` is the part you ' +
    "would name if you are wrong (the look-alike you weighed against), or null. " +
    "`confidence` is 0-1 for the identification. Keep `reasoning` under 20 words " +
    "and say which scale cue decided it. sku must be null only if no reference " +
    "part is the subject of any frame." +
    (lang === "it" ? " Write reasoning in Italian (keep part numbers unchanged)." : "");

  const parts: GeminiPart[] = [{ text: prompt }, ...referenceParts({ onePerSku: true })];
  picked.forEach((f, i) => {
    parts.push({ text: `FRAME ${i + 1} of ${picked.length} (t=${f.t.toFixed(1)}s):` });
    parts.push({
      inline_data: { mime_type: f.mimeType || "image/jpeg", data: rawBase64(f.dataBase64) },
    });
  });

  const out = await geminiVisionCall(parts, {
    route: "pov-reason",
    maxOutputTokens: 220,
    timeoutMs: 30_000,
  });
  const parsed = parseJsonish<ClipIdentity>(out.text);
  const { sku } = resolveFlipSku(parsed.sku);
  return {
    // Only accept a SKU the reference library actually knows.
    sku: sku && GLASSES_COMPONENTS[sku] ? sku : null,
    alternative: typeof parsed.alternative === "string" ? parsed.alternative : null,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
    reasoning: String(parsed.reasoning ?? "").slice(0, 200),
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

type ClipFrame = { t: number; dataBase64: string; mimeType?: string };

/**
 * One vision call over a batch of frames: the reasoner's prompt, the reference
 * images, then the frames. Shared by the clip reasoner and the glasses
 * preview, which ask the same question of the same evidence and differ only
 * in what they do with the answer.
 *
 * `expectSku` narrows the references to the part's family, dropping the
 * look-alike it would otherwise be free to answer with — the lever that
 * actually moved the numbers on device, where prompt wording alone did not.
 * `addendum` goes after the prompt, for a caller that needs more per frame.
 */
async function judgeFrames(
  frames: ClipFrame[],
  opts: { lang?: "en" | "it"; expectSku?: string | null; addendum?: string; extraTokensPerFrame?: number },
) {
  const refParts = referenceParts({ scopeSku: opts.expectSku ?? undefined });
  const parts: GeminiPart[] = [
    { text: buildPrompt(opts.lang, opts.expectSku ?? undefined) + (opts.addendum ?? "") },
    ...refParts,
  ];
  frames.forEach((f, i) => {
    parts.push({ text: `FRAME i=${i} at t=${f.t.toFixed(1)}s of the clip:` });
    parts.push({
      inline_data: { mime_type: f.mimeType || "image/jpeg", data: rawBase64(f.dataBase64) },
    });
  });

  const out = await geminiVisionCall(parts, {
    route: "pov-reason",
    // ~110 tokens of JSON per frame, plus headroom for Italian.
    maxOutputTokens: 260 + frames.length * (170 + (opts.extraTokensPerFrame ?? 0)),
    // A dozen frames on top of the reference library is a much bigger
    // request than a single-photo identification.
    timeoutMs: 60_000,
  });

  const parsed = parseJsonish<{ frames: Array<RawFrame & { scene?: unknown }> }>(out.text);
  const rawFrames = Array.isArray(parsed.frames) ? parsed.frames : [];
  const byIndex = new Map<number, RawFrame & { scene?: unknown }>();
  rawFrames.forEach((f, pos) => {
    const i = Number.isInteger(f?.i) ? Number(f.i) : pos;
    if (i >= 0 && i < frames.length) byIndex.set(i, f);
  });

  /** One entry per frame sent, in order. A frame the model skipped comes back
   *  as an empty, unclear read rather than shifting the ones after it. */
  const raw = frames.map((_, i) => {
    const r = byIndex.get(i);
    return {
      i,
      answered: Boolean(r),
      caption: String(r?.caption ?? ""),
      sku: (r?.sku ?? null) as string | null,
      className: String(r?.className ?? ""),
      orientation: (r?.orientation === "correct" || r?.orientation === "wrong"
        ? r.orientation
        : "unclear") as RawFrame["orientation"],
      confidence: Number(r?.confidence ?? 0),
      reasoning: String(r?.reasoning ?? ""),
      scene: Array.isArray(r?.scene) ? (r!.scene as unknown[]).map((s) => String(s)).slice(0, 6) : [],
    };
  });

  return {
    out,
    // One text part + one image part per reference, so the attached count is
    // half the parts — worth reporting accurately, since the whole point of
    // scoping is that this number goes down.
    attachedRefs: refParts.length / 2,
    raw,
  };
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

    const pinned = body.expectSku ? resolveFlipSku(body.expectSku).sku : null;
    // No pin — settle identity first rather than leaving it to be re-decided on
    // every frame alongside orientation. Below this confidence the pair was not
    // separable from the footage, and scoping on a coin-flip would be worse than
    // not scoping: it would hide the true part from the vocabulary entirely.
    const identity = pinned ? null : await identifyClip(body.frames, body.lang);
    const inferred = identity && identity.confidence >= 0.6 ? identity.sku : null;
    const expectSku = pinned ?? inferred;
    const { out, attachedRefs, raw } = await judgeFrames(body.frames, {
      lang: body.lang,
      expectSku,
    });

    const frames: ReasonedFrame[] = body.frames.map((f, i) => ground(raw[i], f.t));

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
      // What settled the part, so the viewer can show the reasoner's own
      // identification and a reviewer can tell it from a pin they set.
      identity: identity
        ? {
            sku: identity.sku,
            applied: Boolean(inferred),
            alternative: identity.alternative,
            confidence: identity.confidence,
            reasoning: identity.reasoning,
            // True when the runner-up is the SAME-shape partner that runs the
            // OPPOSITE convention. Then identity is not a labelling detail: if
            // it is wrong the verdict is inverted, not merely mis-named. High
            // model confidence is no comfort here — the cone pair reports 0.98
            // either way — so the viewer must caveat rather than assert, and
            // the one-click pin is the way to settle it.
            pairRisk: Boolean(
              inferred &&
                identity.alternative &&
                PAIRS[inferred] === resolveFlipSku(identity.alternative).sku,
            ),
          }
        : {
            sku: pinned,
            applied: Boolean(pinned),
            alternative: null,
            confidence: 1,
            reasoning: "pinned",
            pairRisk: false,
          },
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

/* ── Glasses preview ────────────────────────────────────────────────────────
 *
 * The reasoner above answers "is this part the right way up" for a whole
 * clip. The preview answers a different question about the same clip: what
 * would the operator have seen on the glasses, and when. That takes three
 * things the reasoner does not need:
 *
 *   GET  /glasses  the steps, what each one can warn about, and the clip
 *                  library with the reads kept for each clip
 *   POST /observe  frames read the way the glasses read a frame, one per call,
 *                  on a step, one answer per frame
 *   POST /panel    the two guards replayed over those reads, which is what
 *                  turns reads into a card going up and coming down
 *
 * Reads are made here, by this server, from the uploaded clip: the same
 * reference images and orientation rules as the glasses, but not the glasses'
 * own observe call and not a recording from a device. The guards are the
 * device's logic and thresholds (services/glassesGuard.ts). Every response
 * says which is which so the page never has to guess.
 */

const SKU_KEYS = new Map(Object.keys(GLASSES_COMPONENTS).map((k) => [k.toUpperCase(), k]));

/** Every `-FLIP` identity any step declares: the only parts with a pose class. */
function flipIdentities(): Set<string> {
  const out = new Set<string>();
  for (const s of glassesSpec().steps) {
    for (const d of s.decoys) if (d.decoyFor) out.add(d.sku.toUpperCase());
  }
  return out;
}

/**
 * The part a step's reads are pinned to, as the glasses pin theirs.
 *
 * A step whose decoy is the same part upside down is a step about that one
 * part, so identity is settled by the procedure and vision rules only on
 * pose. Any other step leaves the vocabulary open: at the shim pack the
 * question is which of several parts is in hand.
 */
function pinnedPart(step: GuardStep): string | null {
  const poses = step.decoys.filter((d) => d.decoyFor);
  return poses.length === 1 ? poses[0].decoyFor : null;
}

function partName(sku: string): string | null {
  const key = SKU_KEYS.get(baseSku(sku));
  return key ? GLASSES_COMPONENTS[key].name : null;
}

/* The clip library: station clips that come with the page, each with the reads
   made of it when the library was built (tools/build-glasses-library.mjs).
   Only the reads are kept. The guards are replayed by /panel when a clip is
   opened, so what they do with the reads is always today's thresholds. */

interface LibraryFile {
  _source: { repo: string; ref: string; commit: string; builtOn: string };
  cadenceMs: number;
  clips: Array<{
    id: string;
    file: string;
    sha: string;
    duration: number;
    step: number;
    sku: string;
    shows: "wrong" | "correct" | "wrong_then_correct";
    parts: unknown[];
    readsMadeOn: string;
    model: string;
    references: number;
    reads: unknown[];
  }>;
}

const LIBRARY_JSON = join(SHARED_DIR, "data", "glasses-library.json");
const LIBRARY_CLIPS_DIR = join(EVAL_LAB_PUBLIC, "assets", "glasses-clips");
let libraryCache: { mtimeMs: number; data: LibraryFile } | null = null;

/** The library as the page takes it, or null when there is none. A clip whose
 *  file is not on this server is left out rather than listed and broken, and
 *  so is the whole library if it was read at another cadence than the guards
 *  are replayed at now. */
function glassesLibrary(cadenceMs: number) {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(LIBRARY_JSON).mtimeMs;
  } catch {
    return null;
  }
  if (!libraryCache || libraryCache.mtimeMs !== mtimeMs) {
    libraryCache = { mtimeMs, data: JSON.parse(readFileSync(LIBRARY_JSON, "utf8")) as LibraryFile };
  }
  const { data } = libraryCache;
  if (data.cadenceMs !== cadenceMs) return null;
  return {
    builtOn: data._source.builtOn,
    clips: data.clips
      .filter((c) => existsSync(join(LIBRARY_CLIPS_DIR, c.file)))
      .map((c) => ({
        id: c.id,
        // Video is cached for a week as immutable, so the address carries the
        // file's hash: a rebuilt clip is a new address.
        url: `/lab/assets/glasses-clips/${c.file}?v=${c.sha}`,
        duration: c.duration,
        step: c.step,
        sku: c.sku,
        shows: c.shows,
        parts: c.parts,
        readsMadeOn: c.readsMadeOn,
        model: c.model,
        references: c.references,
        reads: c.reads,
      })),
  };
}

povRouter.get("/glasses", (_req, res, next) => {
  try {
    const spec = glassesSpec();
    const steps = spec.steps.map((s) => {
      const pinned = pinnedPart(s);
      const vocabulary = vocabularySkus(pinned ?? undefined);
      return {
        n: s.n,
        title: s.title,
        detail: s.detail,
        lookFor: s.lookFor,
        guarded: s.parts.length > 0,
        pinned,
        parts: s.parts.map((p) => {
          const key = SKU_KEYS.get(p.sku.toUpperCase());
          return {
            sku: p.sku,
            name: key ? GLASSES_COMPONENTS[key].name : p.description || p.sku,
            image: key && GLASSES_COMPONENTS[key].images[0]
              ? `/lab/assets/pinion-components/${GLASSES_COMPONENTS[key].images[0]}`
              : null,
          };
        }),
        classes: guardClasses(s.n).map((c) => ({
          ...c,
          names: c.skus.map((sku) => partName(sku) ?? sku),
          // A class is only ever raised by a read naming one of its parts, and
          // a read can only name what is in the reference set sent for the
          // step. Where none of a class's parts is, the class is enabled on
          // the glasses but this page cannot show it firing.
          readable: c.skus.filter((sku) => vocabulary.has(baseSku(sku))),
        })),
      };
    });
    res.json({
      source: {
        repo: spec._source.repo,
        ref: spec._source.ref,
        commit: spec._source.commit.slice(0, 8),
        copiedOn: spec._source.copiedOn,
      },
      procedure: { ...spec.procedure, steps: spec.steps.length },
      ready: geminiConfigured(),
      // Seconds between reads on the glasses. Not a setting there: the median
      // measured on the line, which their thresholds were tuned against.
      cadenceMs: spec.observe.cadenceMs,
      cadenceSamples: spec.observe.cadenceSamples,
      framesPerCall: MAX_FRAMES,
      reader: {
        glasses: { model: spec.observe.model, fallback: spec.observe.fallbackModel },
        here: { model: VISION_MODEL },
        references: referenceLibrary().length,
      },
      guard: { wrongPart: spec.wrongPartGuard, sequence: spec.sequenceGuard },
      steps,
      library: glassesLibrary(spec.observe.cadenceMs),
    });
  } catch (e) {
    next(e);
  }
});

const ObserveSchema = z.object({
  clip: z.string().max(200).default("clip"),
  step: z.number().int().min(1).max(99),
  frames: z.array(FrameSchema).min(1).max(MAX_FRAMES),
  lang: z.enum(["en", "it"]).optional(),
});

/** What the reasoner is told about a step that is not about one part. */
function stepClause(step: GuardStep, total: number): string {
  const parts = step.parts.map((p) => `${p.sku}${partName(p.sku) ? ` (${partName(p.sku)})` : ""}`).join(", ");
  return (
    `\n\nACTIVE STEP — the glasses are on step ${step.n} of ${total}: ${step.title}. ` +
    (parts ? `This step's parts: ${parts}. ` : "This step lists no parts. ") +
    "Name the part that is the subject of each frame from the references, " +
    "whichever it is. An operator may pick up a part that belongs to another " +
    "step, and that is exactly what has to be reported, so do not steer a frame " +
    "towards this step's parts. `orientation` is 'correct' for a part with no " +
    "flipped reference, and `confidence` is for the identification.\n"
  );
}

/** The two fields a read on the glasses carries that the reasoner's own
 *  output does not. Appended, so the reasoner's prompt stays word for word. */
const READ_ADDENDUM =
  "\n\nGLASSES READ — this batch is replayed the way the smart glasses read a " +
  "frame, so each frame entry needs one more field and a stricter className:\n" +
  '  - className: a short noun phrase for the part ("bearing cone", "spacer ' +
  'retainer"), or exactly "hands_only" when no reference part is the clear ' +
  "subject of the frame: empty hands, a hand passing through, or only the " +
  'bench, the fixture, tools or background. With "hands_only" set sku to null ' +
  "and confidence to how sure you are that nothing is held. Write " +
  '"hands_only" exactly like that in any language.\n' +
  "  - scene: up to 4 short noun phrases for other things visible in the " +
  "frame. A part that is visible but is not the held subject (lying on the " +
  "bench, half hidden by the glove) goes here, under the same noun phrase you " +
  "would use for its className.\n" +
  'The JSON for this batch is {"frames": [{"i": number, "caption": string, ' +
  '"sku": string|null, "className": string, "orientation": ' +
  '"correct"|"wrong"|"unclear", "confidence": number, "reasoning": string, ' +
  '"scene": string[]}]}, one entry per frame, in order.';

/** Observe calls in flight at once for one request: all of its frames. */
const OBSERVE_PARALLEL = MAX_FRAMES;

interface GlassesRead {
  t: number;
  /** As the glasses would carry it: the part number, or its `-FLIP` identity. */
  sku: string | null;
  /** The real part number, which is what an operator is shown. */
  shownSku: string | null;
  name: string | null;
  className: string;
  confidence: number;
  /** Null for a part that has no pose class, and for empty hands. */
  pose: "correct" | "wrong" | "unclear" | null;
  hands: boolean;
  scene: string[];
  caption: string;
  reasoning: string;
  /** False when the model returned nothing for this frame. */
  answered: boolean;
}

povRouter.post("/observe", async (req, res, next) => {
  try {
    const body = ObserveSchema.parse(req.body);
    const spec = glassesSpec();
    const step = spec.steps.find((s) => s.n === body.step);
    if (!step) return res.status(404).json({ error: `no step ${body.step} in ${spec.procedure.id}` });

    if (!geminiConfigured()) {
      return res.json({
        clip: body.clip,
        step: step.n,
        stubbed: true,
        note: `Vision is not configured on this server: set GEMINI_API_KEY to read clips with ${VISION_MODEL}.`,
        reads: [],
      });
    }

    const pinned = pinnedPart(step);
    // One frame per call, as on the glasses, where every observe call carries
    // a single camera frame. Measured on the flipped-cone station clip: the
    // same eleven frames sent as one batch came back as anything from two to
    // eight wrong-way-up reads from run to run, and sent one at a time came
    // back as nine or ten on every run. In a batch the frames are judged
    // against each other; the guards count reads, so that noise is not
    // something a replay can carry.
    const started = Date.now();
    const single = (f: ClipFrame) =>
      judgeFrames([f], {
        lang: body.lang,
        expectSku: pinned,
        addendum: (pinned ? "" : stepClause(step, spec.steps.length)) + READ_ADDENDUM,
        extraTokensPerFrame: 50,
      });
    type Judged = Awaited<ReturnType<typeof single>>;
    const judged: Array<Judged | null> = new Array(body.frames.length).fill(null);
    let failure: unknown = null;
    let nextFrame = 0;
    await Promise.all(
      Array.from({ length: Math.min(OBSERVE_PARALLEL, body.frames.length) }, async () => {
        while (nextFrame < body.frames.length) {
          const i = nextFrame++;
          try {
            judged[i] = await single(body.frames[i]);
          } catch (e) {
            failure = e;
          }
        }
      }),
    );
    const first = judged.find((j): j is Judged => j !== null);
    // Nothing came back at all: that is an outage, not a clip with no reads.
    if (!first) throw failure ?? new Error("vision returned nothing");
    const out = { model: first.out.model, latencyMs: Date.now() - started };
    const attachedRefs = first.attachedRefs;
    const raw = judged.map((j, i) =>
      j
        ? { ...j.raw[0], i }
        : {
            i, answered: false, caption: "", sku: null as string | null, className: "",
            orientation: "unclear" as RawFrame["orientation"], confidence: 0, reasoning: "", scene: [] as string[],
          },
    );

    const flips = flipIdentities();
    const reads: GlassesRead[] = body.frames.map((f, i) => {
      const r = raw[i];
      const { sku: named, flipDecoy } = resolveFlipSku(r.sku);
      const key = named ? SKU_KEYS.get(named.toUpperCase()) : undefined;
      const className = r.className.trim().slice(0, 80);
      const hands = /^hands[_ ]only$/i.test(className);
      const base = {
        t: f.t,
        confidence: Math.max(0, Math.min(1, r.confidence)),
        // Read alone, a frame often comes back with identifiers ("gloved_hands").
        scene: r.scene.map((s) => s.replace(/_/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 4),
        caption: r.caption.slice(0, 240),
        reasoning: r.reasoning.slice(0, 240),
        answered: r.answered,
      };
      // Only a part the reference library knows is a part number here. Anything
      // else the model names is an object in the frame, not a catalogue read.
      if (hands || !key) {
        return { ...base, sku: null, shownSku: null, name: null, className: hands ? "hands_only" : className, pose: null, hands };
      }
      const hasPose = flips.has(`${key.toUpperCase()}-FLIP`);
      const wrong = flipDecoy || r.orientation === "wrong";
      const pose = !hasPose ? null : wrong ? "wrong" : r.orientation === "correct" ? "correct" : "unclear";
      return {
        ...base,
        sku: pose === "wrong" ? `${key}-FLIP` : key,
        shownSku: key,
        name: GLASSES_COMPONENTS[key].name,
        className: className || "part",
        pose,
        hands: false,
      };
    });

    res.json({
      clip: body.clip,
      step: step.n,
      stubbed: false,
      model: out.model,
      latencyMs: out.latencyMs,
      references: attachedRefs,
      pinned,
      reads,
    });
  } catch (e) {
    next(e);
  }
});

const PanelSchema = z.object({
  step: z.number().int().min(1).max(99),
  /** Where the replay stops, in clip seconds: time-outs run up to here. */
  endT: z.number().min(0).max(36_000),
  reads: z
    .array(
      z.object({
        t: z.number().min(0).max(36_000),
        sku: z.string().max(40).nullable(),
        className: z.string().max(80),
        confidence: z.number().min(0).max(1),
        pose: z.enum(["correct", "wrong", "unclear"]).nullable().optional(),
        scene: z.array(z.string().max(60)).max(6).default([]),
      }),
    )
    .max(600),
});

povRouter.post("/panel", (req, res, next) => {
  try {
    const body = PanelSchema.parse(req.body);
    const observations: Observation[] = body.reads.map((r) => ({
      t: r.t,
      // A pose the reasoner would not rule on is no read of the part at all.
      // The glasses' model has no such answer: it must name a class, and on a
      // doubtful frame it is told to name the correct one, which resets the
      // count towards a warning. Passing the frame through as undecided does
      // the same to the count without also claiming a correct read was seen.
      sku: r.pose === "unclear" ? null : r.sku,
      className: r.className,
      confidence: r.confidence,
      scene: r.scene,
    }));
    const replay = replayGuards(body.step, observations, body.endT);
    res.json({ step: body.step, endT: body.endT, ...replay });
  } catch (e) {
    next(e);
  }
});
