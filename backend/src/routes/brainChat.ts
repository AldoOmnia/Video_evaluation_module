/**
 * POST /api/brain/chat
 *
 * Body: { query: string, model?: string }
 * Returns: { answer, citations[], stubbed, retrieved[] }
 *
 * Wires retrieval (real, against the actual graph) + LLM generation
 * (real or stubbed). The eval lab Brain mode replaces its in-browser
 * stubbedLLMCall by calling this endpoint.
 */
import { Router } from "express";
import { z } from "zod";

import { specs } from "../services/specs.js";
import { retrieveRelevantNodes } from "../services/retrieval.js";
import { llmCall } from "../services/anthropic.js";
import { buildBrainSystemPrompt } from "../../../shared/prompt-assembly/systemPrompt.js";

const BodySchema = z.object({
  query: z.string().min(1).max(2000),
  model: z.string().optional(),
  k: z.number().int().positive().max(20).optional(),
});

export const brainChatRouter = Router();

brainChatRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const retrieved = retrieveRelevantNodes(
      specs.procedure,
      body.query,
      body.k ?? 6,
    );
    const userMsg = [
      `Question: ${body.query}`,
      "",
      "Retrieved nodes (cite as [[id]]):",
      ...retrieved.map((n) => `- ${n.id} (${n.type}): ${n.label}`),
    ].join("\n");

    const sys = buildBrainSystemPrompt(specs.procedure, specs.taxonomy);
    const result = await llmCall({
      system: sys,
      user: userMsg,
      maxTokens: 400,
      model: body.model,
    });

    const citations = extractCitations(result.text);

    res.json({
      answer: result.text,
      citations,
      retrieved,
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

function extractCitations(text: string): string[] {
  const ids: string[] = [];
  const re = /\[\[([a-z]+:[\w-]+)\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return Array.from(new Set(ids));
}
