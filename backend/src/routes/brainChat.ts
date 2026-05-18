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
import { retrieveRelevantNodes, scoreNodes, type GraphNode } from "../services/retrieval.js";
import { llmCall } from "../services/anthropic.js";
import { buildBrainSystemPrompt } from "../../../shared/prompt-assembly/systemPrompt.js";

/** Client-supplied ingested artifact. Same shape as backend GraphNode but
 *  with a permissive `raw` so PDF/CSV extracted text comes through. */
const ClientArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  raw: z.unknown().optional(),
});

const BodySchema = z.object({
  query: z.string().min(1).max(2000),
  model: z.string().optional(),
  k: z.number().int().positive().max(20).optional(),
  /** Artifacts ingested in the browser (PDF text, CSV rows, etc.).
   *  Sent each turn so the backend can score them alongside the canonical graph. */
  artifacts: z.array(ClientArtifactSchema).max(200).optional(),
});

export const brainChatRouter = Router();

brainChatRouter.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const k = body.k ?? 6;

    // 1. canonical procedure-graph candidates
    const fromGraph = retrieveRelevantNodes(specs.procedure, body.query, k * 2);

    // 2. client artifacts → score the same way so they compete fairly
    const artifactNodes: GraphNode[] = (body.artifacts ?? []).map((a) => ({
      id: a.id,
      type: a.type,
      label: a.label,
      raw: a.raw ?? {},
    }));
    const scoredArtifacts = scoreNodes(artifactNodes, body.query);

    // 3. merge + cap, prefer artifacts on ties (they're more specific)
    const merged: GraphNode[] = [
      ...scoredArtifacts.map((s) => s.node),
      ...fromGraph,
    ].slice(0, k);

    const userMsg = [
      `Question: ${body.query}`,
      "",
      "Retrieved nodes (cite as [[id]]):",
      ...merged.map((n) => `- ${n.id} (${n.type}): ${n.label}${nodeContentSnippet(n)}`),
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
      retrieved: merged,
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

/** Surface a tiny excerpt to the prompt so the LLM can ground on file content,
 *  not just titles. Strict caps so we don't blow up token usage. */
function nodeContentSnippet(n: GraphNode): string {
  const r = n.raw as Record<string, unknown> | undefined;
  if (!r) return "";
  const text = typeof r.extractedText === "string" ? r.extractedText : "";
  if (!text) return "";
  const snippet = text.slice(0, 320).replace(/\s+/g, " ").trim();
  return `\n    excerpt: ${snippet}${text.length > 320 ? " …" : ""}`;
}
