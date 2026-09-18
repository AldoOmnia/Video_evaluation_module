/**
 * POST /api/brain/chat
 *
 * Brain lab mode — same pipeline as POST /query (glasses lens + lab brief).
 * Returns structured lens preview so the UI matches what workers see on device.
 */
import { Router } from "express";
import { z } from "zod";

import { scoreNodes, type GraphNode } from "../services/retrieval.js";
import { runGlassesQuery } from "../services/glassesQuery.js";

const ClientArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  raw: z.unknown().optional(),
});

const BodySchema = z.object({
  query: z.string().min(1).max(2000),
  model: z.string().optional(),
  k: z.number().int().positive().max(12).optional(),
  artifacts: z.array(ClientArtifactSchema).max(50).optional(),
  lang: z.enum(["en", "it"]).optional(),
  tone: z.enum(["enterprise", "technical", "coaching"]).optional(),
});

export const brainChatRouter = Router();

brainChatRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);

    const artifactNodes: GraphNode[] = (body.artifacts ?? []).map((a) => ({
      id: a.id,
      type: a.type,
      label: a.label,
      raw: a.raw ?? {},
    }));

    const result = await runGlassesQuery({
      route: "brain-chat",
      transcript: body.query,
      artifactNodes,
      k: body.k ?? 8,
      maxTokens: 480,
      model: body.model,
      lang: body.lang,
      tone: body.tone,
    });

    const answer =
      result.labBrief.headline ||
      [result.lens.label, result.lens.value, result.lens.action]
        .filter(Boolean)
        .join(" — ");

    res.json({
      answer,
      labBrief: result.labBrief,
      lens: result.lens,
      glassesLines: result.glassesLines,
      isAction: result.isAction,
      rawAnswer: result.rawAnswer,
      citations: result.citations,
      retrieved: result.retrieved,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
      },
      latencyMs: result.latencyMs,
      stubbed: result.stubbed,
    });
  } catch (e) {
    next(e);
  }
});
