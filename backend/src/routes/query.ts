/**
 * POST /query  — Rokid APK-compatible endpoint.
 *
 * Uses the same glasses Q&A pipeline as /api/brain/chat so the eval lab
 * and the APK see identical lens formatting (4-role AnswerCard).
 */
import { Router } from "express";
import { z } from "zod";

import { runGlassesQuery } from "../services/glassesQuery.js";

const BodySchema = z.object({
  transcript: z.string().min(1),
  image_base64: z.string().optional(),
  image_media_type: z.string().optional(),
});

export const queryRouter = Router();

queryRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const transcript = body.image_base64
      ? `${body.transcript} [image attached — read labels, part numbers, gauges]`
      : body.transcript;

    const result = await runGlassesQuery({
      transcript,
      k: 5,
      maxTokens: 280,
    });

    res.json({
      line1: result.glassesLines[0],
      line2: result.glassesLines[1],
      line3: result.glassesLines[2],
      line4: result.glassesLines[3],
      isAction: result.isAction,
      rawAnswer: result.rawAnswer,
      stubbed: result.stubbed,
    });
  } catch (e) {
    next(e);
  }
});
