/**
 * Component recognition — the glasses' VLM vocabulary, shared by every
 * platform surface that looks at a picture of a part.
 *
 * The reference library is the whole point: for each SKU the glasses build
 * ships correct-orientation photos AND the -FLIP decoys, and it is only by
 * attaching both, labeled, that a model can say "this one is upside down"
 * instead of merely naming the part. Anything that wants an orientation
 * verdict — the Brain dock's attached photos (/api/assist), the POV clip
 * reasoner (/api/pov) — must go through here so the platform and the device
 * judge orientation off identical evidence.
 *
 * Loading the images costs ~1MB of base64, so the library is built once and
 * memoized for the process lifetime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { geminiVisionCall, VISION_MODEL, type GeminiPart } from "./gemini.js";
import { GLASSES_COMPONENTS } from "../routes/kb.js";
import { EVAL_LAB_PUBLIC, SHARED_DIR } from "../paths.js";

export interface RefEntry {
  sku: string;
  name: string;
  fingerprint: string;
  mime: string;
  dataBase64: string;
  /** e.g. "correct orientation", "FLIPPED — wrong orientation (decoy)",
   *  side-view or side-by-side contrast labels */
  pose: string;
}

let refCache: RefEntry[] | null = null;

/** Labels mirror how the glasses annotate their reference vocabulary. */
export function poseLabel(file: string): string {
  // In-station capture: gloved, handheld, real fixture and lighting. This is
  // the deployment presentation, and the reason these frames matter is scale —
  // a part alone on a bench has nothing to measure against, and the cup and
  // cone pairs can only be told apart by size once orientation alone is
  // ambiguous. Say so, so the model uses the hand and fixture as the ruler.
  if (/_station_(correct|wrong)/i.test(file)) {
    const wrong = /_station_wrong/i.test(file);
    return (
      `IN-STATION, GLOVED — ${wrong ? "FLIPPED, wrong orientation (decoy)" : "correct orientation"}. ` +
      "Handheld at the fixture under station lighting, which is how the glasses " +
      "actually see the part. The gloved hand and the fixture are the scale " +
      "reference: use them to judge this part's diameter before deciding which " +
      "member of a look-alike pair it is"
    );
  }
  if (/^bearing_cups_/i.test(file)) {
    // Side-by-side rim-width contrast shots from glasses commit a92ac902.
    const up = /timken_up/i.test(file);
    return (
      `SIDE-BY-SIDE CONTRAST — big cup 248114A1 next to small cup 191440A1, both TIMKEN face ${up ? "UP" : "DOWN"}. ` +
      "The big cup's stamped rim is a visibly THICKER/WIDER flat annulus than the small cup's narrow band — use rim width + diameter to tell the cups apart before applying orientation rules"
    );
  }
  if (/_side/i.test(file)) return "SIDE VIEW — identity reference only; a cup's taper is internal, orientation cannot be judged from this angle";
  return /flip/i.test(file) ? "FLIPPED — wrong orientation (decoy)" : "correct orientation";
}

/**
 * Per-SKU orientation rules, ported from the glasses observe prompt
 * (comer-rokid-demo backend/routes/vlmObserve.js, branch
 * connectors/mssql-unicomm-database).
 *
 * These exist because "is this part upside-down" cannot be answered generically.
 * Each pair runs its own convention — and the two pairs run OPPOSITE ones — so
 * the only reliable form is a per-SKU statement of which face up means which
 * verdict. Every clause here was arrived at against live frames on device; the
 * platform must apply the identical rules or it will contradict the glasses on
 * the same part, which is worse than saying nothing.
 *
 * Two asymmetries carried over deliberately:
 *
 *  - Ambiguity resolves to CORRECT, not to a warning. A false WRONG ORIENTATION
 *    on a good part costs an operator's trust and a needless rework check; a
 *    miss costs one frame out of an observe loop that runs continuously.
 *  - The small cup 191440A1 is the exception, because its faces differ only in
 *    the WIDTH and FINISH of the up-face. Requiring legible engraving there
 *    meant a genuinely inverted cup went unreported on ~9 of 10 frames, so
 *    unreadable lettering explicitly does NOT license a default to correct.
 */
export const ORIENTATION_RULES: string[] = [
  "STAMPED CODE IS AUTHORITATIVE: if you can read a part-number code on the part, it OVERRIDES shape similarity — return the SKU matching the READ code even if the silhouette resembles a different reference. Never output a SKU that contradicts a clearly legible stamped code.",
  "RETAINER RING vs BEARING CUP (a ring is not enough): the closed retainer rings 92203637 / 92203640 and the bearing cups 248114A1 / 191440A1 are ALL large steel rings, so silhouette alone cannot separate them. A retainer ring MUST show TWO through-holes ~180° apart — a required feature, not an optional cue. A bearing cup has NO holes, a TAPERED internal raceway, and maker lettering ('TIMKEN', 'NP241715', '572 CD1 RM VN'). Two visible holes → retainer ring. Maker lettering or a tapered raceway → bearing cup, never a retainer. Neither holes nor a legible code → sku=null, className 'metal ring', confidence ≤0.5.",
  "SMALL BEARING CONE, step 6 (67190R91 vs 67190R91-FLIP — the SAME physical cone; decide ONLY by which FACE points at the camera):",
  "- Up-face is a FLAT solid machined RING (smooth annulus around an open bore, rollers angling AWAY/downward, NOT standing up) → correct → 67190R91. This face is also the only one carrying stamped text.",
  "- Up-face is the ANGLED ROLLER CAGE standing up (slanted rollers narrowing to a smaller tapered opening, no flat ring face) → upside-down → 67190R91-FLIP.",
  "- TEXT CHECK (corroboration, not a requirement): only the flat ring face carries lettering. Stamped letters on the up-face ⇒ flat ring up ⇒ correct. Absence of text supports FLIP ONLY alongside an unmistakable roller-cage shape — NEVER output FLIP on missing text alone.",
  "- SIDE / EDGE-ON (rollers seen as a row of vertical bars; the bore shows at the top in BOTH orientations, so IGNORE it): judge by where the SMOOTH roller-free steel band sits. Band along the TOP above the rollers → correct → 67190R91. Band along the BOTTOM below the rollers, rollers flaring WIDER toward the top → 67190R91-FLIP. If you cannot locate the band on either edge, DEFAULT TO CORRECT.",
  "INBOARD BEVEL PINION CONE, step 4 (248118A1 vs 248118A1-FLIP — LARGER than 67190R91 and the OPPOSITE convention):",
  "- Up-face is the ANGLED ROLLER CAGE / wide open tapered bore, NO stamped text → correct → 248118A1.",
  "- Up-face is the FLAT machined RING with stamped maker text around the bore → upside-down → 248118A1-FLIP.",
  "- SIDE VIEW: smooth roller-free band along the BOTTOM below the rollers → correct (248118A1); band along the TOP → 248118A1-FLIP.",
  "- CRITICAL — OPPOSITE OF THE STEP-6 CONE: for 67190R91 the stamped flat face UP is CORRECT; for 248118A1 the stamped flat face UP is WRONG. Settle WHICH cone it is first (size / given part context), then apply that cone's own rule.",
  "BIG BEARING CUP, step 1 (248114A1 vs 248114A1-FLIP — a cup is an outer race RING, smooth tapered bore, NO rollers or cage):",
  "- Up-face is the STAMPED MAKER face, a flat-ish rim carrying engraved text ('TIMKEN', 'NP241715', 'USA') around the bore → correct (TIMKEN side UP, per the line engineer) → 248114A1. The big cup's stamped rim is noticeably THICKER / WIDER than the small cup's — a strong size cue even when the stamp is unreadable.",
  "- Up-face is a BRIGHT smooth polished TAPERED RACEWAY angling down and inward, wide mouth up, NO lettering → inverted → 248114A1-FLIP.",
  "- The big cup follows the SAME convention as the step-6 cone: stamped text up = correct. The SMALL cup is the opposite.",
  "- SIDE / EDGE-ON: you see only the plain cylindrical OUTER wall. A cup's taper is INTERNAL, so orientation CANNOT be judged from a pure side view — use it to recognise WHICH cup is present, and NEVER output a cup -FLIP from a side view alone.",
  "SMALL COVER CUP, step 2 (191440A1 vs 191440A1-FLIP — ~140mm OD, visibly smaller than 248114A1). Judge by the WIDTH and FINISH of the up-face, NOT by reading its engraving: at working distance its lettering is usually illegible, so requiring legible text means a genuinely inverted cup goes unreported:",
  "- Up-face shows a WIDE, BRIGHT, SMOOTH tapered raceway — a broad polished light-grey conical band just inside the rim, clearly WIDER than the thin dark outer edge, bore reading noticeably SMALLER than the outer diameter — and NO lettering → correct (TIMKEN side DOWN, per the line engineer) → 191440A1.",
  "- Up-face is the STAMPED MAKER face — a NARROW flat ring with fine radial grinding marks — and past that narrow ring the bore opens WIDE, so you see mostly THROUGH the part with only a thin internal wall visible → inverted → 191440A1-FLIP.",
  "- Both poses are attached as references. COMPARE the up-face against BOTH and return whichever it resembles more. Do NOT fall back to 191440A1 just because the engraving is unreadable — wide-bright-band vs narrow-flat-ring is the primary signal and text is only corroboration.",
  "- CRITICAL — THE TWO CUPS USE OPPOSITE CONVENTIONS: BIG cup 248114A1 correct = TIMKEN text UP; SMALL cup 191440A1 correct = TIMKEN text DOWN (bare raceway up). Never carry one cup's rule onto the other — size the cup first, then apply its rule.",
  "- TELLING THE CUPS APART (see the side-by-side 'bearing_cups_...' references): the BIG cup has a visibly THICKER stamped rim — a broad flat ring of metal around the bore — where the small cup's is a much NARROWER band. Rim width plus overall diameter decide which cup it is before any orientation rule applies.",
  "- The ONLY frames where the small cup defaults to CORRECT are those where NEITHER face is really visible: a pure side/edge-on view, a cup tilted so far the up-face reads as neither a wide bright band nor a narrow flat ring, or a motion-blurred frame. Unreadable lettering on an otherwise clear up-face is NOT one of those cases.",
  "BIAS — when a pose is genuinely too ambiguous to apply the rule above (tilted, partly hidden, glare, motion-blurred), DEFAULT TO THE CORRECT SKU rather than its -FLIP. Output a -FLIP ONLY when the wrong-side-up face is unmistakable. A false WRONG ORIENTATION on a good part is worse than a miss — never guess FLIP. The one exception is the small cup 191440A1 above, where unreadable lettering is NOT grounds for defaulting to correct.",
];

/** All vendored 768px reference images per SKU (correct-orientation AND flip
 *  decoys, labeled) + the catalogue visual fingerprint — the same vocabulary
 *  the glasses observe loop attaches, so orientation can be judged too. */
export function referenceLibrary(): RefEntry[] {
  if (refCache) return refCache;
  let fingerprints = new Map<string, string>();
  try {
    const cat = JSON.parse(
      readFileSync(join(SHARED_DIR, "data", "pinion-parts-catalogue.json"), "utf8"),
    ) as { parts: Array<{ part_number_cnh?: string; part_number_comer?: string; visual_fingerprint?: string; _synthetic?: boolean }> };
    fingerprints = new Map(
      cat.parts
        .filter((p) => !p._synthetic)
        .map((p) => [p.part_number_cnh || p.part_number_comer || "", p.visual_fingerprint || ""]),
    );
  } catch { /* catalogue missing — fingerprints stay empty */ }

  const imgDir = join(EVAL_LAB_PUBLIC, "assets", "pinion-components");
  const refs: RefEntry[] = [];
  for (const [sku, cfg] of Object.entries(GLASSES_COMPONENTS)) {
    for (const file of cfg.images) {
      try {
        const buf = readFileSync(join(imgDir, file));
        refs.push({
          sku,
          name: cfg.name,
          fingerprint: fingerprints.get(sku) ?? "",
          mime: "image/jpeg",
          dataBase64: buf.toString("base64"),
          pose: poseLabel(file),
        });
      } catch { /* image not vendored — skip */ }
    }
  }
  refCache = refs;
  return refs;
}

/**
 * SKUs to withhold from the vocabulary when a call is scoped to one part,
 * keyed scoped SKU → the SKUs it is confusable with.
 *
 * Ported from the glasses' ALWAYS_INCLUDE_CONFLICTS + the 92203640 removal
 * (comer-rokid-demo fd7035f2, ee0a87d2, 08341f10), where all of this is
 * measured on device rather than reasoned about:
 *
 *  - Keeping a look-alike partner in vocabulary does not aid discrimination,
 *    it supplies the wrong answer. Holding ONLY the brushed retainer 92203637,
 *    14 of 23 confident reads came back as its partner 92203640 at 0.85-0.98;
 *    adding an explicit thickness contrast to the prompt only moved it to
 *    12 of 26. Dropping the partner from the reference set is what fixed it.
 *  - A bearing cup IS a large steel annulus, so the C-ring 229515A2 and both
 *    closed retainer rings collide with the cups by shape whatever the
 *    catalogue filing says. On live glasses a CORRECT cup read 229515A2 at
 *    0.9 and raised a wrong-part warning on a good part.
 *  - Withholding globally is the wrong fix, also measured: against the cones
 *    the C-ring is shape-distinct and earns its place as a contrast class
 *    (17/17 with it, 15/17 without). So it goes only where it collides.
 *
 * Hence an explicit SKU map rather than a category lookup.
 */
const SCOPE_WITHHOLD: Record<string, string[]> = {
  // The cups: the other cup, plus every other large steel ring in the corpus.
  "248114A1": ["191440A1", "229515A2", "92203637", "92203640"],
  "191440A1": ["248114A1", "229515A2", "92203637", "92203640"],
  // The cones are shape-distinct from the rings, so only the sibling cone —
  // which runs the OPPOSITE orientation convention — has to go.
  "248118A1": ["67190R91"],
  "67190R91": ["248118A1"],
};

/** Floor on a scoped reference set. Too few references starves the model of
 *  the contrast it needs to reject a look-alike, so fall back to everything
 *  rather than narrow past this (glasses: VLM_NARROW_MIN_REFS). */
const SCOPE_MIN_REFS = 2;

/**
 * The labeled reference images as Gemini parts, ready to prepend to a call.
 *
 * `scopeSku` narrows the vocabulary the way the glasses narrow to the active
 * KeyStep's parts: the scoped part keeps all of its own poses (correct AND
 * flip — an orientation verdict is a comparison between the two), the SKUs it
 * is confusable with are withheld, and everything shape-distinct stays as
 * contrast. On device this narrowing is the difference between deterministic
 * and coin-flip identification for the look-alike pairs.
 */
export function referenceParts(opts: { scopeSku?: string } = {}): GeminiPart[] {
  const all = referenceLibrary();
  const scope = opts.scopeSku?.trim().toUpperCase();
  let refs = all;
  if (scope && SCOPE_WITHHOLD[scope]) {
    const drop = new Set(SCOPE_WITHHOLD[scope]);
    const narrowed = all.filter((r) => !drop.has(r.sku.toUpperCase()));
    if (narrowed.length >= SCOPE_MIN_REFS && narrowed.length < all.length) refs = narrowed;
  }

  const parts: GeminiPart[] = [];
  for (const r of refs) {
    parts.push({
      text: `REFERENCE sku=${r.sku} — ${r.name} — ${r.pose}${r.fingerprint ? ` — fingerprint: ${r.fingerprint}` : ""}`,
    });
    parts.push({ inline_data: { mime_type: r.mime, data: r.dataBase64 } });
  }
  return parts;
}

/** Strips a data-URL preamble so callers can pass either form. */
export function rawBase64(dataBase64: string): string {
  return dataBase64.replace(/^data:[^;]+;base64,/, "");
}

/** Parses the raw JSON (or fenced JSON) a vision model answers with. */
export function parseJsonish<T>(text: string): Partial<T> {
  try {
    const clean = text.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as Partial<T>;
  } catch {
    return {};
  }
}

/**
 * The glasses resolve their FLIP decoys to the real part number and carry the
 * wrong-orientation state in a separate flag — the overlay must never show an
 * operator a synthetic "-FLIP" id. Anything reading a model's `sku` back has
 * to normalize the same way.
 */
export function resolveFlipSku(rawSku: unknown): { sku: string | null; flipDecoy: boolean } {
  const raw = typeof rawSku === "string" ? rawSku.trim() : "";
  return { sku: raw ? raw.replace(/-FLIP$/i, "") : null, flipDecoy: /-FLIP$/i.test(raw) };
}

export interface VisionId {
  sku: string | null;
  className: string;
  confidence: number;
  flipped: boolean;
  reasoning: string;
}

/** Identify one image against the glasses reference vocabulary. */
export async function identifyImage(
  img: { dataBase64: string; mimeType?: string },
  question: string,
  lang?: "en" | "it",
): Promise<{ id: VisionId; model: string; latencyMs: number; stubbed: boolean }> {
  const refs = referenceLibrary();
  const prompt =
    "You are the component-recognition VLM for a Comer Industries assembly line " +
    "(pinion cover pre-assembly, station ST.100). The reference images below are " +
    "the vocabulary — the SAME set the smart-glasses observe loop uses. Identify " +
    "the part in the USER IMAGE by comparing against them. Match on SHAPE and the " +
    "visual fingerprints, not on the reference's exact pose or background. " +
    "If nothing matches, sku must be null and className a plain description. " +
    "If the part matches a reference but is UPSIDE-DOWN / wrong-side-up compared " +
    "to its correct-orientation reference, set flipped=true; you may name the " +
    "part's -FLIP class in `sku` as the glasses do, and it will be resolved back " +
    "to the real part number before an operator sees it. " +
    // Same rules the device applies, so a photo asked about in the chat cannot
    // get a different verdict from the same part seen through the glasses.
    "ORIENTATION RULES — apply these exactly; they are the glasses' own:\n" +
    ORIENTATION_RULES.join("\n") +
    "\n" +
    'Answer ONLY with raw JSON: {"sku": string|null, "className": string, ' +
    '"confidence": number 0-1, "flipped": boolean, "reasoning": string ' +
    "(1-2 sentences, mention the distinguishing features you used)}." +
    (question ? ` The user also asked: "${question}" — factor it into reasoning.` : "") +
    (lang === "it"
      ? " The user's interface is ITALIAN: write className and reasoning in Italian (keep SKUs and proper nouns unchanged)."
      : "");

  const parts: GeminiPart[] = [{ text: prompt }, ...referenceParts()];
  parts.push({ text: "USER IMAGE — identify this part:" });
  parts.push({
    inline_data: {
      mime_type: img.mimeType || "image/jpeg",
      data: rawBase64(img.dataBase64),
    },
  });

  const res = await geminiVisionCall(parts);
  if (res.stubbed) {
    return {
      id: {
        sku: null,
        className: "vision stub — set GEMINI_API_KEY to run the same VLM as the glasses",
        confidence: 0,
        flipped: false,
        reasoning: `No GEMINI_API_KEY on the server. Live path runs ${VISION_MODEL} against ${refs.length} glasses reference images.`,
      },
      model: "stub",
      latencyMs: res.latencyMs,
      stubbed: true,
    };
  }
  const parsed = parseJsonish<VisionId>(res.text);
  const { sku, flipDecoy } = resolveFlipSku(parsed.sku);
  return {
    id: {
      sku,
      className: String(parsed.className ?? res.text.slice(0, 120)),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
      flipped: Boolean(parsed.flipped) || flipDecoy,
      reasoning: String(parsed.reasoning ?? ""),
    },
    model: res.model,
    latencyMs: res.latencyMs,
    stubbed: false,
  };
}
