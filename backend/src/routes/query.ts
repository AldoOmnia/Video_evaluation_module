/**
 * POST /query  — Rokid APK-compatible endpoint.
 *
 * The existing comer-rokid-demo BackendClient.kt POSTs
 *   { transcript: string, image_base64?: string, image_media_type?: string }
 * and expects
 *   { line1, line2, line3, line4, isAction, rawAnswer }
 *
 * We replicate that exact contract here so the existing APK can point at
 * this platform's backend without code changes. Under the hood we now use
 * the shared prompt-assembly + display-constraints modules so the
 * production runtime and the eval lab share their logic.
 */
import { Router } from "express";
import { z } from "zod";

import { specs } from "../services/specs.js";
import { retrieveRelevantNodes } from "../services/retrieval.js";
import { llmCall } from "../services/anthropic.js";
import { buildBrainSystemPrompt } from "../../../shared/prompt-assembly/systemPrompt.js";
import { fitToDisplay } from "../../../shared/display-constraints/rokid.js";

const BodySchema = z.object({
  transcript: z.string().min(1),
  image_base64: z.string().optional(),
  image_media_type: z.string().optional(),
});

export const queryRouter = Router();

queryRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const retrieved = retrieveRelevantNodes(specs.procedure, body.transcript, 5);

    const sys = buildBrainSystemPrompt(specs.procedure, specs.taxonomy);
    const userMsg = [
      `Worker says: "${body.transcript}"`,
      "",
      "Retrieved procedural context:",
      ...retrieved.map((n) => `- ${n.id} (${n.type}): ${n.label}`),
      "",
      body.image_base64
        ? "[image attached — read part numbers, nameplates, labels, or QR/barcodes]"
        : "",
      "",
      "Answer in one short, glanceable sentence (≤ 88 chars total).",
    ].join("\n");

    const llm = await llmCall({ system: sys, user: userMsg, maxTokens: 200 });
    const rokid =
      specs.hardware.profiles["rokid_ai"] ??
      Object.values(specs.hardware.profiles)[0];
    const display = fitToDisplay(llm.text, rokid);

    res.json({
      line1: display.lines[0],
      line2: display.lines[1],
      line3: display.lines[2],
      line4: display.lines[3],
      isAction: /\b(stop|halt|reject|do not)\b/i.test(llm.text),
      rawAnswer: llm.text,
    });
  } catch (e) {
    next(e);
  }
});
