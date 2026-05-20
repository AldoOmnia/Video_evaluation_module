/**
 * Shared glasses Q&A pipeline — Brain chat + POST /query (APK).
 */
import { specs } from "./specs.js";
import { retrieveRelevantNodes, scoreNodes, type GraphNode } from "./retrieval.js";
import { llmCall } from "./anthropic.js";
import {
  buildGlassesQuerySystemPrompt,
  buildGlassesQueryUserMessage,
} from "../../../shared/prompt-assembly/glassesQueryPrompt.js";
import { parseGlassesQueryResponse } from "../../../shared/glasses-query/parseGlassesQueryResponse.js";
import {
  fitFourRole,
  coerceFourRole,
} from "../../../shared/display-constraints/rokid.js";
import type { FourRoleLens } from "../../../shared/types/events.js";

export interface GlassesQueryInput {
  transcript: string;
  /** Client artifacts from Brain ingest (optional). */
  artifactNodes?: GraphNode[];
  k?: number;
  maxTokens?: number;
  model?: string;
}

export interface GlassesQueryResult {
  lens: FourRoleLens;
  glassesLines: [string, string, string, string];
  labBrief: { headline: string; bullets: string[] };
  isAction: boolean;
  rawAnswer: string;
  retrieved: GraphNode[];
  citations: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stubbed: boolean;
}

function nodeExcerpt(n: GraphNode): string | undefined {
  const r = n.raw as Record<string, unknown> | undefined;
  const text = typeof r?.extractedText === "string" ? r.extractedText : "";
  if (!text) return undefined;
  return text.slice(0, 200).replace(/\s+/g, " ").trim();
}

export async function runGlassesQuery(
  input: GlassesQueryInput,
): Promise<GlassesQueryResult> {
  const k = input.k ?? 5;
  const hw =
    specs.hardware.profiles["rokid_ai"] ??
    Object.values(specs.hardware.profiles)[0];

  const fromGraph = retrieveRelevantNodes(specs.procedure, input.transcript, k * 2);
  const artifacts = input.artifactNodes ?? [];
  const scoredArtifacts = scoreNodes(artifacts, input.transcript);
  const merged: GraphNode[] = [
    ...scoredArtifacts.map((s) => s.node),
    ...fromGraph,
  ].slice(0, k);

  const userMsg = buildGlassesQueryUserMessage(
    input.transcript,
    merged.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      excerpt: nodeExcerpt(n),
    })),
  );

  const sys = buildGlassesQuerySystemPrompt(specs.procedure, hw);
  const llm = await llmCall({
    system: sys,
    user: userMsg,
    maxTokens: input.maxTokens ?? 320,
    model: input.model,
  });

  const parsed = parseGlassesQueryResponse(llm.text);
  const rawRoles = coerceFourRole(
    parsed.lens,
    parsed.labBrief.headline || llm.text,
  );
  if (!rawRoles.label && !rawRoles.value) {
    rawRoles.label = "INFO";
    rawRoles.value = (parsed.labBrief.headline || "See detail").slice(0, 16);
    rawRoles.action = rawRoles.action || "Continue procedure";
    rawRoles.source = rawRoles.source || "Lab brief below";
  }
  const lensFit = fitFourRole(rawRoles, hw);
  const lens: FourRoleLens = {
    label: lensFit.label,
    value: lensFit.value,
    action: lensFit.action,
    source: lensFit.source,
  };
  const glassesLines = lensFit.lines;

  const citations = extractCitations(
    [parsed.labBrief.headline, ...parsed.labBrief.bullets, llm.text].join(" "),
  );

  return {
    lens,
    glassesLines,
    labBrief: parsed.labBrief,
    isAction: parsed.isAction || /\b(stop|halt|reject|do not)\b/i.test(llm.text),
    rawAnswer: parsed.rawText || llm.text,
    retrieved: merged,
    citations,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    latencyMs: llm.latencyMs,
    stubbed: llm.stubbed,
  };
}

function extractCitations(text: string): string[] {
  const ids: string[] = [];
  const re = /\[\[([a-z]+:[\w-]+)\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return Array.from(new Set(ids));
}
