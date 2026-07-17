/**
 * Shared glasses Q&A pipeline — Brain chat + POST /query (APK).
 */
import { specs } from "./specs.js";
import { flattenProcedure, scoreNodes, type GraphNode } from "./retrieval.js";
import { knowledgeNodes } from "./knowledge.js";
import { llmCall } from "./anthropic.js";
import { buildStationScopeGuard } from "../routes/kb.js";
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
  /** UI language — "it" makes every user-facing string Italian. */
  lang?: "en" | "it";
  /** Response register — set from the platform admin settings. */
  tone?: "enterprise" | "technical" | "coaching";
}

/** Admin-selected response register. Grounding, citations and the four-role
 *  lens contract are identical in every register — only the voice changes. */
const TONE_DIRECTIVES: Record<string, string> = {
  enterprise: [
    "",
    "REGISTER: the workspace is set to ENTERPRISE. Write for plant directors",
    "and managers — concise, formal, decision-ready. Lead with the conclusion,",
    "keep bullets tight, no filler.",
  ].join("\n"),
  technical: [
    "",
    "REGISTER: the workspace is set to TECHNICAL. Write for process and test",
    "engineers — specs first: torque values, SKUs, tolerances and detection",
    "logic up front, minimal framing around them.",
  ].join("\n"),
  coaching: [
    "",
    "REGISTER: the workspace is set to COACHING. Write the way a trainer walks",
    "an operator through the task — step by step, plain instructions, name the",
    "mistake to avoid and how to recover from it.",
  ].join("\n"),
};

/** Appended to the system prompt when the platform toggle is on ITA.
 *  Technical identity stays untouched: part numbers, SKUs, station ids,
 *  step refs (S07) and [[citations]] are shared vocabulary on the line. */
const ITALIAN_DIRECTIVE = [
  "",
  "LINGUA: the user's interface is set to ITALIAN. Write ALL user-facing text",
  "in Italian — glassesMessage label/value/action/source AND labBrief headline",
  "and bullets. Use natural shop-floor Italian (registro tecnico, dare del",
  '"tu" all\'operatore). Keep unchanged: part numbers/SKUs, station ids',
  "(ST100), step refs (S07), tool codes, [[citations]], and proper nouns",
  "(TIMKEN, UNICOMM). Numbers keep their units as-is (Nm, mm).",
].join("\n");

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
  return text.slice(0, 480).replace(/\s+/g, " ").trim();
}

export async function runGlassesQuery(
  input: GlassesQueryInput,
): Promise<GlassesQueryResult> {
  const k = input.k ?? 5;
  const hw =
    specs.hardware.profiles["rokid_ai"] ??
    Object.values(specs.hardware.profiles)[0];

  // One corpus, one ranking: canonical procedure + plant knowledge (operator
  // field notes, historical error rates, facility KB) + client artifacts.
  const procedureNodes = flattenProcedure(specs.procedure);
  const corpus: GraphNode[] = [
    ...(input.artifactNodes ?? []),
    ...knowledgeNodes(),
    ...procedureNodes,
  ];
  const scored = scoreNodes(corpus, input.transcript);
  const merged: GraphNode[] =
    scored.length > 0
      ? scored.slice(0, k).map((s) => s.node)
      : procedureNodes.slice(0, k); // empty/no-match query fallback

  // Anti-hallucination: if the question touches stations other than ST100,
  // tell the model exactly what little data exists for them. Added AFTER
  // retrieval scoring so the guard text itself doesn't skew ranking.
  const scopeGuard = buildStationScopeGuard(input.transcript);
  const promptTranscript = scopeGuard
    ? `${scopeGuard}\n\n${input.transcript}`
    : input.transcript;

  const userMsg = buildGlassesQueryUserMessage(
    promptTranscript,
    merged.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      excerpt: nodeExcerpt(n),
    })),
  );

  const sys =
    buildGlassesQuerySystemPrompt(specs.procedure, hw) +
    (input.tone && TONE_DIRECTIVES[input.tone] ? TONE_DIRECTIVES[input.tone] : "") +
    (input.lang === "it" ? ITALIAN_DIRECTIVE : "");
  // Italian prose runs ~25-40% longer than English for the same content —
  // without headroom the JSON gets truncated mid-string and parsing fails.
  const baseTokens = input.maxTokens ?? 320;
  const llm = await llmCall({
    system: sys,
    user: userMsg,
    maxTokens: input.lang === "it" ? Math.round(baseTokens * 1.5) : baseTokens,
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
