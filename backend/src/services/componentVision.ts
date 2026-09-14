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

/** The labeled reference images as Gemini parts, ready to prepend to a call. */
export function referenceParts(): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const r of referenceLibrary()) {
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
    "to its correct-orientation reference, still return the plain sku (NEVER " +
    "append -FLIP) and set flipped=true — exactly how the glasses resolve their " +
    "FLIP decoys. " +
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
