/**
 * POST /api/assist — the platform-wide Brain dock (right-side chat).
 *
 * Mirrors the glasses architecture 1:1 so platform testing equals device
 * testing:
 *   - text questions   → same retrieval + Claude pipeline as the glasses
 *     /query endpoint (runGlassesQuery: procedure + tribal knowledge +
 *     error rates + facility KB).
 *   - attached images  → Gemini vision (gemini-3.5-flash, 2.5 fallback —
 *     the exact models the glasses VLM-observe loop runs) with the SAME
 *     per-SKU reference images + visual fingerprints the glasses attach,
 *     then the identification is handed to Claude to ground the answer
 *     in the knowledge base.
 *
 * The caller sends a `context` describing the window in focus (page,
 * station, view) so answers stay scoped to what the user is looking at.
 */
import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { runGlassesQuery } from "../services/glassesQuery.js";
import { geminiVisionCall, geminiConfigured, VISION_MODEL, type GeminiPart } from "../services/gemini.js";
import { GLASSES_COMPONENTS, findGlassesComponent } from "./kb.js";
import { EVAL_LAB_PUBLIC, SHARED_DIR } from "../paths.js";

export const assistRouter = Router();

const ContextSchema = z.object({
  page: z.string().max(80).optional(),
  station: z.string().max(80).optional(),
  view: z.string().max(120).optional(),
  detail: z.string().max(400).optional(),
});
const ImageSchema = z.object({
  name: z.string().max(200),
  dataBase64: z.string().min(8).max(6_000_000), // ~4.5MB binary
  mimeType: z.string().max(60).optional(),
});
const BodySchema = z.object({
  query: z.string().max(2000).default(""),
  images: z.array(ImageSchema).max(3).default([]),
  context: ContextSchema.optional(),
  k: z.number().int().positive().max(12).optional(),
});

/* ── Reference library (same content the glasses attach) ─────────────── */

interface RefEntry {
  sku: string;
  name: string;
  fingerprint: string;
  mime: string;
  dataBase64: string;
}
let refCache: RefEntry[] | null = null;

/** One canonical 768px reference image per SKU + its catalogue visual
 *  fingerprint — the dedupe-by-SKU strategy the glasses observe loop uses. */
function referenceLibrary(): RefEntry[] {
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
    const file = cfg.images[0];
    if (!file) continue;
    try {
      const buf = readFileSync(join(imgDir, file));
      refs.push({
        sku,
        name: cfg.name,
        fingerprint: fingerprints.get(sku) ?? "",
        mime: "image/jpeg",
        dataBase64: buf.toString("base64"),
      });
    } catch { /* image not vendored — skip */ }
  }
  refCache = refs;
  return refs;
}

interface VisionId {
  sku: string | null;
  className: string;
  confidence: number;
  reasoning: string;
}

async function identifyImage(
  img: { dataBase64: string; mimeType?: string },
  question: string,
): Promise<{ id: VisionId; model: string; latencyMs: number; stubbed: boolean }> {
  const refs = referenceLibrary();
  const prompt =
    "You are the component-recognition VLM for a Comer Industries assembly line " +
    "(pinion cover pre-assembly, station ST.100). The reference images below are " +
    "the vocabulary — the SAME set the smart-glasses observe loop uses. Identify " +
    "the part in the USER IMAGE by comparing against them. Match on SHAPE and the " +
    "visual fingerprints, not on the reference's exact pose or background. " +
    "If nothing matches, sku must be null and className a plain description. " +
    'Answer ONLY with raw JSON: {"sku": string|null, "className": string, ' +
    '"confidence": number 0-1, "reasoning": string (1-2 sentences, mention the ' +
    "distinguishing features you used)}." +
    (question ? ` The user also asked: "${question}" — factor it into reasoning.` : "");

  const parts: GeminiPart[] = [{ text: prompt }];
  for (const r of refs) {
    parts.push({
      text: `REFERENCE sku=${r.sku} — ${r.name}${r.fingerprint ? ` — fingerprint: ${r.fingerprint}` : ""}`,
    });
    parts.push({ inline_data: { mime_type: r.mime, data: r.dataBase64 } });
  }
  parts.push({ text: "USER IMAGE — identify this part:" });
  parts.push({
    inline_data: {
      mime_type: img.mimeType || "image/jpeg",
      data: img.dataBase64.replace(/^data:[^;]+;base64,/, ""),
    },
  });

  const res = await geminiVisionCall(parts);
  if (res.stubbed) {
    return {
      id: {
        sku: null,
        className: "vision stub — set GEMINI_API_KEY to run the same VLM as the glasses",
        confidence: 0,
        reasoning: `No GEMINI_API_KEY on the server. Live path runs ${VISION_MODEL} against ${refs.length} glasses reference images.`,
      },
      model: "stub",
      latencyMs: res.latencyMs,
      stubbed: true,
    };
  }
  let parsed: Partial<VisionId> = {};
  try {
    const clean = res.text.replace(/```(?:json)?/g, "").trim();
    parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
  } catch { /* fall through to defaults */ }
  return {
    id: {
      sku: typeof parsed.sku === "string" && parsed.sku ? parsed.sku : null,
      className: String(parsed.className ?? res.text.slice(0, 120)),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
      reasoning: String(parsed.reasoning ?? ""),
    },
    model: res.model,
    latencyMs: res.latencyMs,
    stubbed: false,
  };
}

/* ── Route ────────────────────────────────────────────────────────────── */

assistRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    if (!body.query.trim() && body.images.length === 0) {
      return res.status(400).json({ error: "query or image required" });
    }

    const ctx = body.context;
    const ctxLine = ctx
      ? [ctx.page && `page: ${ctx.page}`, ctx.station && `station in focus: ${ctx.station}`, ctx.view && `view: ${ctx.view}`, ctx.detail]
          .filter(Boolean)
          .join(" · ")
      : "";

    // 1. Vision — identify the attached image with the glasses' VLM setup.
    let vision: {
      model: string;
      latencyMs: number;
      stubbed: boolean;
      sku: string | null;
      className: string;
      confidence: number;
      reasoning: string;
      component: { name: string; steps: string[]; errorCodes: string[]; warning: unknown } | null;
    } | null = null;

    if (body.images.length > 0) {
      const v = await identifyImage(body.images[0], body.query);
      const kbComp = v.id.sku ? findGlassesComponent(v.id.sku) : null;
      const cfg = v.id.sku ? GLASSES_COMPONENTS[v.id.sku] : undefined;
      vision = {
        model: v.model,
        latencyMs: v.latencyMs,
        stubbed: v.stubbed,
        ...v.id,
        component: kbComp
          ? {
              name: kbComp.name,
              steps: kbComp.steps ?? [],
              errorCodes: kbComp.errorCodes,
              warning: kbComp.warning ?? null,
            }
          : cfg
            ? { name: cfg.name, steps: [], errorCodes: cfg.codes, warning: null }
            : null,
      };
    }

    // 2. Knowledge — same Claude pipeline the glasses /query runs, with the
    //    focus context and any vision identification folded into the question.
    const transcriptParts = [
      ctxLine && `[the user is looking at — ${ctxLine}]`,
      vision && !vision.stubbed
        ? vision.sku
          ? `[attached photo identified by the vision model as: ${vision.component?.name ?? vision.className} (SKU ${vision.sku}, confidence ${vision.confidence.toFixed(2)})` +
            (vision.component && vision.component.steps.length ? ` — used in ${vision.component.steps.join(", ")}` : "") +
            (vision.component && vision.component.errorCodes.length ? ` — watched for ${vision.component.errorCodes.join(", ")}` : "") +
            "]"
          : `[attached photo — vision model saw: ${vision.className}, no catalogue match]`
        : "",
      body.query.trim() ||
        (vision ? "What is this component, where is it used in the procedure, and what should be watched for?" : ""),
    ].filter(Boolean);

    const result = await runGlassesQuery({
      transcript: transcriptParts.join("\n"),
      k: body.k ?? 8,
      maxTokens: 480,
    });

    res.json({
      answer:
        result.labBrief.headline ||
        [result.lens.label, result.lens.value, result.lens.action].filter(Boolean).join(" — "),
      labBrief: result.labBrief,
      lens: result.lens,
      citations: result.citations,
      retrieved: result.retrieved.map((n) => ({ id: n.id, type: n.type, label: n.label })),
      vision,
      stubbed: result.stubbed,
      latencyMs: result.latencyMs,
      models: {
        knowledge: "claude (same pipeline as the glasses /query)",
        vision: geminiConfigured() ? VISION_MODEL : "stub — GEMINI_API_KEY not set",
      },
    });
  } catch (e) {
    next(e);
  }
});
