/**
 * The bolt camera checks: which bolt is held up to this device's camera.
 *
 * Two reads of one camera, asked separately by the page:
 *
 *   find   a Roboflow detector, about 0.12 s. Where the bolts are, so the
 *          page can draw a box that follows them. Its class is not used.
 *   call   Gemini, told the step in words, about 1.5 s. Which bolt each one
 *          is for this step.
 *
 * Why the detector's class is not the answer. The detectors were trained on
 * footage from the glasses. Measured 2026-11-19 on frames from an iPad's
 * back camera and a laptop's front camera, two bolts side by side, labelled
 * by eye: on the laptop the case 02 detector called the correct bolt by the
 * wrong bolt's class on 44 of 47 frames, and the case 03 detector called the
 * wrong bolt by the correct bolt's class on 12 of 12. Cutting the frame down
 * to the bolts did not change that.
 *
 * Why the step is given in words. Measured through these routes on the same
 * saved frames, `gemini-3.5-flash`, told which bolt is wrong and which is
 * correct for the step:
 *
 *   two bolts side by side   both called right on 54 of 55 frames (35 iPad,
 *                            20 laptop in warm light against a red shirt).
 *                            The other one called the blue bolt `unsure`.
 *   one bolt held alone      right on 15 of 15 (iPad: the washer bolt under
 *                            case 02 on 8, the blue bolt under case 03 on 7)
 *   no bolt in the picture   none listed on 22 of 22, six of which the
 *                            detector had boxed (a face, a chair)
 *
 * The step text names the mark that decides it. Both bolts that are not the
 * pink one carry a thin pink line of their own, and with the step worded as
 * "pink band" against "no pink band" the bolts held alone were called right
 * on 1 of 5.
 *
 * The tab has to be the step the bolts belong to. The wrong bolt of case 02
 * and the correct bolt of case 03 are both grey with a wide pink band and
 * differ in length, which one picture without a scale does not show: case 02
 * bolts read under the case 03 step had the wrong one called `correct` on
 * most frames.
 *
 * Not measured: any camera or light other than those two, and a single
 * pink bolt of either case held alone.
 *
 * This is the web page's read only. The glasses do not call it and it calls
 * nothing of theirs: their bolt read is `boltPick.js` in comer-rokid-demo,
 * which pairs the detector's class with the colour of the shank and is
 * measured on their own camera.
 *
 * Nothing is kept between calls.
 */

import { geminiConfigured, geminiVisionCall, VISION_MODEL } from "./gemini.js";

const DETECT_HOST = "https://detect.roboflow.com";
const ROBOFLOW_KEY = (process.env.EMOTIV_ROBOFLOW_API_KEY ?? process.env.ROBOFLOW_API_KEY ?? "").trim();

/** The detector's own floor on the glasses path. Boxes under it are not drawn. */
const BOX_FLOOR = 0.4;
/** Two boxes over this overlap are one bolt the detector named twice. */
const SAME_BOLT_IOU = 0.6;
/** More boxes than this are not bolts held up to a camera. */
const MAX_BOLTS = 4;
const FIND_TIMEOUT_MS = 8_000;
/** An answer takes about 1.5 s. One that is not back by now is asked of the fallback model. */
const CALL_TIMEOUT_MS = 5_000;

/** A failure, for the log. Never the address that was called: it carries the key. */
function why(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/key=[^&\s"']+/gi, "key=…").slice(0, 240);
}

export type BoltService = "bolt-02" | "bolt-03";

interface BoltStep {
  title: string;
  /** Finds bolts. Either detector does; each case keeps the one the glasses route for it. */
  detectorId: string;
  /** The step, as the model is told it. */
  step: string;
  /** Under "Wrong bolt". */
  wrongDetail: string;
  /** Which one is marked, for two bolts in view. */
  wrongSeen: string;
}

export const BOLT_STEPS: Record<BoltService, BoltStep> = {
  "bolt-02": {
    title: "Bolt case 02",
    detectorId:
      (process.env.EMOTIV_BOLT_02_DETECTOR ?? "").trim() ||
      "omnia-cvi0f/dakkota-bolt-standoff-v1-1-rfdetr-medium-t1",
    step:
      "The station step is bolt case 02. Two kinds of bolt can be in view. WRONG for this step: a bolt with no washer, only the flange of its own head, and a wide bright pink band of threadlock around its thread. CORRECT for this step: a bolt with a separate washer sitting under its head. The washer decides it: a bolt with a washer is CORRECT even when a thin pink line shows on its thread.",
    wrongDetail: "This is the short bolt with the wide pink band. The correct one has a washer.",
    wrongSeen: "the short one, with the wide pink band",
  },
  "bolt-03": {
    title: "Bolt case 03",
    detectorId:
      (process.env.EMOTIV_BOLT_03_DETECTOR ?? "").trim() ||
      "omnia-cvi0f/dakkota-bolt-heads-v1-1-rfdetr-medium-t1",
    step:
      "The station step is bolt case 03. Two kinds of bolt can be in view. WRONG for this step: a short bolt with a blue head and a blue coating on its thread. The blue decides it: a blue bolt is WRONG even when a thin pink line shows on its thread. CORRECT for this step: a long silver-grey bolt with a wide bright pink band of threadlock around its thread and no blue on it.",
    wrongDetail: "This is the short blue bolt. The long one is correct.",
    wrongSeen: "the short blue one",
  },
};

// `at` is asked for so a call can be put on the right box when the detector
// has boxed something that is not a bolt. [y, x] over 1000 is the order and
// scale Gemini gives points in.
const ASK =
  'Look at the photo. List every bolt you can see, in order from the left of the image to the right. For each give what you see, where its middle is, and your call for this step. Answer with JSON only: {"bolts":[{"pink_band":true|false,"washer":true|false,"blue":true|false,"at":[y,x],"call":"wrong"|"correct"|"unsure"}]}. "at" is the middle of the bolt as [y, x], each from 0 to 1000 of the image height and width. Use "unsure" when the marks that decide it are not visible. If no bolt is in view answer {"bolts":[]}.';

const HOLD = "Hold the bolt side on, so the thread and the head both show.";

export function isBoltService(service: string): service is BoltService {
  return service === "bolt-02" || service === "bolt-03";
}

/** Both reads are needed: the boxes without the call say nothing. */
export function boltsConfigured(): { detector: boolean; vlm: boolean; ready: boolean } {
  const detector = ROBOFLOW_KEY.length > 0;
  const vlm = geminiConfigured();
  return { detector, vlm, ready: detector && vlm };
}

function stripDataUrl(s: string): string {
  const i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}

// ── find ─────────────────────────────────────────────────────────────────

export interface BoltBox {
  /** Top left corner, in the pixels of `image`. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FindReply =
  | { ok: true; service: BoltService; boxes: BoltBox[]; image: { width: number; height: number }; models: string[]; latencyMs: number }
  | { ok: false; service: BoltService; reason: string; models: string[]; latencyMs: number };

interface Prediction {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  confidence?: number;
}

function iou(a: BoltBox, b: BoltBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * The detector's boxes as the page draws them: over the floor, largest
 * first, one per bolt, left to right. Exported for the check.
 */
export function boltBoxes(predictions: Prediction[]): BoltBox[] {
  const boxes = predictions
    .map((p) => {
      const w = Number(p.width);
      const h = Number(p.height);
      const c = Number(p.confidence);
      const conf = Number.isFinite(c) ? (c > 1 ? c / 100 : c) : 0;
      if (!(w > 0) || !(h > 0) || conf < BOX_FLOOR) return null;
      return { x: Math.round(Number(p.x) - w / 2), y: Math.round(Number(p.y) - h / 2), width: Math.round(w), height: Math.round(h) };
    })
    .filter((b): b is BoltBox => b !== null && Number.isFinite(b.x) && Number.isFinite(b.y))
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const kept: BoltBox[] = [];
  for (const box of boxes) {
    if (kept.length >= MAX_BOLTS) break;
    if (!kept.some((k) => iou(k, box) > SAME_BOLT_IOU)) kept.push(box);
  }
  return kept.sort((a, b) => a.x - b.x);
}

/** Where the bolts are in one frame. Never throws. */
export async function findBolts(service: BoltService, frame: string): Promise<FindReply> {
  const started = Date.now();
  const id = BOLT_STEPS[service].detectorId;
  const fail = (reason: string): FindReply => ({ ok: false, service, reason, models: [id], latencyMs: Date.now() - started });
  if (!ROBOFLOW_KEY) return fail("no_detector_key");
  const qs = new URLSearchParams({ api_key: ROBOFLOW_KEY, confidence: String(Math.round(BOX_FLOOR * 100)), overlap: "50" });
  try {
    const res = await fetch(`${DETECT_HOST}/${id}?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stripDataUrl(frame),
      signal: AbortSignal.timeout(FIND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[emotiv-camera] ${service} detector HTTP ${res.status}`);
      return fail(`detector_http_${res.status}`);
    }
    const json = (await res.json()) as { predictions?: Prediction[]; image?: { width?: number; height?: number } };
    const width = Number(json.image?.width);
    const height = Number(json.image?.height);
    if (!(width > 0) || !(height > 0)) return fail("detector_no_size");
    return {
      ok: true,
      service,
      boxes: boltBoxes(Array.isArray(json.predictions) ? json.predictions : []),
      image: { width, height },
      models: [id],
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.warn(`[emotiv-camera] ${service} detector failed: ${why(err)}`);
    return fail("detector_failed");
  }
}

// ── call ─────────────────────────────────────────────────────────────────

export type BoltCall = "wrong" | "correct" | "unsure";

export interface CalledBolt {
  call: BoltCall;
  /** Its middle, as a share of the picture's width and height. Null when not given. */
  at: { x: number; y: number } | null;
}

export type CallReply =
  | {
      ok: true;
      service: BoltService;
      /** Left to right in the picture. */
      bolts: CalledBolt[];
      verdict: "ok" | "bad" | null;
      headline: string;
      detail: string;
      models: string[];
      latencyMs: number;
    }
  | { ok: false; service: BoltService; reason: string; models: string[]; latencyMs: number };

/**
 * The model's answer as a list of calls, or null when it is not one.
 * Anything that is not `wrong` or `correct` is `unsure`. Exported for the check.
 */
export function parseCalls(text: string): CalledBolt[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let body: unknown;
  try {
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const bolts = (body as { bolts?: unknown })?.bolts;
  if (!Array.isArray(bolts)) return null;
  const called = bolts.slice(0, MAX_BOLTS).map((b): CalledBolt => {
    const said = String((b as { call?: unknown })?.call ?? "").toLowerCase();
    const at = (b as { at?: unknown })?.at;
    const y = Array.isArray(at) ? Number(at[0]) : NaN;
    const x = Array.isArray(at) ? Number(at[1]) : NaN;
    const inside = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1000;
    return {
      call: said === "wrong" || said === "correct" ? said : "unsure",
      at: inside(x) && inside(y) ? { x: x / 1000, y: y / 1000 } : null,
    };
  });
  // Left to right by where each one is, when every one says where.
  return called.every((b) => b.at) ? called.sort((a, b) => a.at!.x - b.at!.x) : called;
}

/**
 * The page's words for a list of calls. Exported for the check.
 *
 * One bolt is a verdict. Two or more are a verdict only when they agree:
 * one wrong and one correct held up to compare is neither, and each box
 * carries its own mark. A side is never named, because a camera that faces
 * the user is shown mirrored.
 */
export function boltWords(service: BoltService, bolts: CalledBolt[]): { verdict: "ok" | "bad" | null; headline: string; detail: string } {
  const step = BOLT_STEPS[service];
  const wrong = bolts.filter((b) => b.call === "wrong").length;
  const correct = bolts.filter((b) => b.call === "correct").length;
  const n = bolts.length;
  if (n === 0) return { verdict: null, headline: "No bolt in view", detail: HOLD };
  if (n === 1) {
    if (wrong) return { verdict: "bad", headline: "Wrong bolt", detail: step.wrongDetail };
    if (correct) return { verdict: "ok", headline: "Correct bolt", detail: "This is the bolt for this step." };
    return { verdict: null, headline: "Cannot tell", detail: `The marks that decide it are not showing. ${HOLD}` };
  }
  const count = n === 2 ? "Two" : `${n}`;
  if (wrong === n) return { verdict: "bad", headline: `${count} wrong bolts`, detail: step.wrongDetail };
  if (correct === n) return { verdict: "ok", headline: `${count} correct bolts`, detail: "These are the bolt for this step." };
  if (wrong) {
    return { verdict: null, headline: `${count} bolts in view`, detail: `The wrong one is marked: ${step.wrongSeen}.` };
  }
  return { verdict: null, headline: `${count} bolts in view`, detail: `Not every one can be told. ${HOLD}` };
}

/** Which bolt each one is, for the step. Never throws. */
export async function callBolts(service: BoltService, frame: string): Promise<CallReply> {
  const started = Date.now();
  const fail = (reason: string, model = VISION_MODEL): CallReply => ({
    ok: false,
    service,
    reason,
    models: [model],
    latencyMs: Date.now() - started,
  });
  if (!geminiConfigured()) return fail("no_vlm_key");
  try {
    const out = await geminiVisionCall(
      [
        { text: `${BOLT_STEPS[service].step}\n\n${ASK}` },
        { inline_data: { mime_type: "image/jpeg", data: stripDataUrl(frame) } },
      ],
      { route: "emotiv-camera", maxOutputTokens: 300, timeoutMs: CALL_TIMEOUT_MS },
    );
    const bolts = parseCalls(out.text);
    if (!bolts) {
      console.warn(`[emotiv-camera] ${service} ${out.model} answer not readable: ${out.text.slice(0, 160)}`);
      return fail("vlm_unreadable", out.model);
    }
    if (out.model !== VISION_MODEL) console.warn(`[emotiv-camera] ${service} answered by ${out.model}, not ${VISION_MODEL}`);
    return { ok: true, service, bolts, ...boltWords(service, bolts), models: [out.model], latencyMs: Date.now() - started };
  } catch (err) {
    console.warn(`[emotiv-camera] ${service} call failed: ${why(err)}`);
    return fail("vlm_failed");
  }
}
