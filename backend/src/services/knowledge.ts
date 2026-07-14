/**
 * Plant knowledge corpus for the Brain chat — everything beyond the formal
 * procedure spec that the LLM should answer from:
 *
 *   1. Operator field notes (supervisor-knowledge/v1 JSONs vendored from the
 *      main glasses build, comer-rokid-demo). First-hand shop-floor facts —
 *      "the shimming step is our biggest problem, 3-4 help calls a day".
 *   2. Historical error rates (shared/data/error-rates.csv) — the ranked
 *      "most common mistakes" table for the pinion guide station.
 *   3. The facility knowledge base store (.kb-store.json) — material,
 *      components, and POV warning-logic findings added over time in /knowledge/.
 *
 * Everything is flattened into retrieval GraphNodes so the existing keyword
 * scorer + prompt assembly work unchanged. The `extractedText` field on raw
 * is what surfaces as the excerpt in the LLM prompt.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { GraphNode } from "./retrieval.js";
import { SHARED_DIR, EVAL_LAB_PUBLIC } from "../paths.js";

const SUPERVISOR_DIR = join(SHARED_DIR, "data", "supervisor-knowledge");
const ERROR_RATES_CSV = join(SHARED_DIR, "data", "error-rates.csv");
const KB_STORE_PATH = join(EVAL_LAB_PUBLIC, ".kb-store.json");

interface SupervisorFact {
  id: string;
  topic?: string;
  step_codes?: string[];
  fact: string;
  applies_when?: string | null;
  citation?: { transcript_quote?: string };
  confidence?: string;
}
interface SupervisorDoc {
  _kind: string;
  _phase_tag?: string;
  _step_title?: string;
  _recorded_by?: string;
  facts?: SupervisorFact[];
}

function node(
  id: string,
  type: string,
  label: string,
  text: string,
  extra: Record<string, unknown> = {},
): GraphNode {
  return { id, type, label, raw: { extractedText: text, ...extra } };
}

/* ── 1. Operator field notes (static — loaded once) ──────────────────── */

function loadSupervisorNodes(): GraphNode[] {
  const nodes: GraphNode[] = [];
  if (!existsSync(SUPERVISOR_DIR)) return nodes;
  for (const f of readdirSync(SUPERVISOR_DIR).filter((f) => f.endsWith(".json")).sort()) {
    let doc: SupervisorDoc;
    try {
      doc = JSON.parse(readFileSync(join(SUPERVISOR_DIR, f), "utf8")) as SupervisorDoc;
    } catch {
      continue;
    }
    if (doc._kind !== "supervisor-knowledge/v1" || !Array.isArray(doc.facts)) continue;
    const src = doc._phase_tag || doc._step_title || f;
    for (const fact of doc.facts) {
      const quote = fact.citation?.transcript_quote
        ? ` Operator said: "${fact.citation.transcript_quote}"`
        : "";
      const when = fact.applies_when ? ` (applies when: ${fact.applies_when})` : "";
      nodes.push(
        node(
          `fact:${fact.id}`,
          "TribalKnowledge",
          `Operator note (${src}) — ${fact.topic || "note"}`,
          `${fact.fact}${when}${quote}`,
          {
            phase: src,
            stepCodes: fact.step_codes ?? [],
            topic: fact.topic,
            confidence: fact.confidence,
            recordedBy: doc._recorded_by,
          },
        ),
      );
    }
  }
  return nodes;
}

/* ── 2. Historical error rates ────────────────────────────────────────── */

function loadErrorRateNodes(): GraphNode[] {
  if (!existsSync(ERROR_RATES_CSV)) return [];
  const lines = readFileSync(ERROR_RATES_CSV, "utf8").trim().split("\n").slice(1);
  const rows = lines
    .map((l) => {
      // step_id,step_label,rate,top_error_code,notes — notes may be quoted
      const m = l.match(/^([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/);
      if (!m) return null;
      return {
        stepId: m[1],
        stepLabel: m[2],
        rate: parseFloat(m[3]),
        code: m[4],
        notes: m[5].replace(/^"|"$/g, ""),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null && Number.isFinite(r.rate));

  const nodes = rows.map((r) =>
    node(
      `errrate:${r.stepId}`,
      "ErrorRate",
      `Historical error rate — ${r.stepLabel} (${r.stepId})`,
      `${r.stepLabel}: ${r.rate} defects per 1000 units, top error ${r.code}.${r.notes ? ` ${r.notes}.` : ""}`,
      { ...r },
    ),
  );

  // Aggregate ranking node — lands directly on "most common mistakes" queries.
  const ranked = [...rows].sort((a, b) => b.rate - a.rate);
  nodes.unshift(
    node(
      "errrate:ranking",
      "ErrorRate",
      "Most common mistakes / errors at the pinion guide station (historical ranking)",
      "Ranked by historical defect rate per 1000 units: " +
        ranked
          .map((r, i) => `${i + 1}. ${r.stepLabel} (${r.stepId}) — ${r.rate}/1000, ${r.code}${r.notes ? ` (${r.notes})` : ""}`)
          .join("; ") +
        ".",
      { ranked },
    ),
  );
  return nodes;
}

/* ── 3. Facility knowledge-base store (dynamic — read per query) ─────── */

interface KbStoreShape {
  stations?: Record<
    string,
    {
      artifacts?: { id: string; name: string; type: string; note?: string | null }[];
      components?: { id: string; name: string; note?: string | null; errorCodes?: string[] }[];
      povs?: {
        id: string;
        name: string;
        label: string;
        note?: string | null;
        transcript?: string | null;
        analysis?: {
          summary?: string;
          suggestions?: {
            step?: string | null;
            errorCode?: string | null;
            observed?: string;
            detect?: string;
            glassesWarning?: string;
          }[];
        } | null;
      }[];
    }
  >;
}

function loadKbStoreNodes(): GraphNode[] {
  const nodes: GraphNode[] = [];
  if (!existsSync(KB_STORE_PATH)) return nodes;
  let store: KbStoreShape;
  try {
    store = JSON.parse(readFileSync(KB_STORE_PATH, "utf8")) as KbStoreShape;
  } catch {
    return nodes;
  }
  for (const [stationId, bucket] of Object.entries(store.stations ?? {})) {
    for (const a of bucket.artifacts ?? []) {
      nodes.push(
        node(
          `kb:art:${a.id}`,
          "Document",
          `Training material at ${stationId} — ${a.name}`,
          `${a.type.toUpperCase()} uploaded to the ${stationId} knowledge base.${a.note ? ` Note: ${a.note}` : ""}`,
          { stationId },
        ),
      );
    }
    for (const c of bucket.components ?? []) {
      nodes.push(
        node(
          `kb:comp:${c.id}`,
          "Part",
          `Component reference at ${stationId} — ${c.name}`,
          `${c.name} is a tracked component at ${stationId}.` +
            (c.errorCodes?.length ? ` Mapped failure modes: ${c.errorCodes.join(", ")}.` : "") +
            (c.note ? ` ${c.note}` : ""),
          { stationId, errorCodes: c.errorCodes ?? [] },
        ),
      );
    }
    for (const p of bucket.povs ?? []) {
      if (!p.analysis) continue;
      const sugg = (p.analysis.suggestions ?? [])
        .map((s) => `${s.step ?? "?"} ${s.errorCode ?? ""}: ${s.observed ?? ""} Detect: ${s.detect ?? ""}`)
        .join(" | ");
      nodes.push(
        node(
          `kb:pov:${p.id}`,
          "TribalKnowledge",
          `POV recording finding at ${stationId} — ${p.name} (${p.label})`,
          `${p.analysis.summary ?? ""}${sugg ? ` Suggested warning logic: ${sugg}` : ""}`,
          { stationId, label: p.label },
        ),
      );
    }
  }
  return nodes;
}

/* ── Public API ───────────────────────────────────────────────────────── */

const staticNodes: GraphNode[] = [...loadSupervisorNodes(), ...loadErrorRateNodes()];

/** All plant-knowledge nodes: static corpus + current knowledge-base store. */
export function knowledgeNodes(): GraphNode[] {
  return [...staticNodes, ...loadKbStoreNodes()];
}

export const knowledgeStats = Object.freeze({
  operatorFacts: staticNodes.filter((n) => n.type === "TribalKnowledge").length,
  errorRateRows: staticNodes.filter((n) => n.type === "ErrorRate").length,
});
