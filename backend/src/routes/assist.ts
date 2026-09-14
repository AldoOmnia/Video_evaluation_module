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
import { z } from "zod";

import { runGlassesQuery } from "../services/glassesQuery.js";
import { geminiConfigured, VISION_MODEL } from "../services/gemini.js";
import { identifyImage } from "../services/componentVision.js";
import { GLASSES_COMPONENTS, findGlassesComponent } from "./kb.js";

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
  lang: z.enum(["en", "it"]).optional(),
  tone: z.enum(["enterprise", "technical", "coaching"]).optional(),
});

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
      flipped: boolean;
      reasoning: string;
      component: { name: string; steps: string[]; errorCodes: string[]; warning: unknown } | null;
    } | null = null;

    if (body.images.length > 0) {
      const v = await identifyImage(body.images[0], body.query, body.lang);
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
            (vision.flipped ? " — shown in the WRONG ORIENTATION (flipped); on the glasses this would fire the orientation warning right now" : "") +
            (vision.component && vision.component.steps.length ? ` — used in ${vision.component.steps.join(", ")}` : "") +
            (vision.component && vision.component.errorCodes.length ? ` — watched for ${vision.component.errorCodes.join(", ")}` : "") +
            "]"
          : `[attached photo — vision model saw: ${vision.className}, no catalogue match]`
        : "",
      body.query.trim() ||
        (vision ? "What is this component, where is it used in the procedure, and what should be watched for?" : ""),
    ].filter(Boolean);

    const result = await runGlassesQuery({
      route: "assist-text",
      transcript: transcriptParts.join("\n"),
      k: body.k ?? 8,
      maxTokens: 480,
      lang: body.lang,
      tone: body.tone,
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
