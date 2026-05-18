/**
 * Graph retrieval — same scoring the eval lab uses in-browser, so the
 * Brain chat ranking is identical web-side and server-side.
 *
 * NOT semantic search yet — keyword + type-bias. When Supabase pgvector
 * lands (Phase 2 per handoff), this is the seam to replace.
 */
import type { ProcedureSpec } from "../../../shared/types/procedure.js";

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  raw: unknown;
}

export function flattenProcedure(p: ProcedureSpec): GraphNode[] {
  const nodes: GraphNode[] = [];
  nodes.push({
    id: p.proceduralActivity.id,
    type: "ProceduralActivity",
    label: p.proceduralActivity.label,
    raw: p.proceduralActivity,
  });
  for (const k of p.keysteps)
    nodes.push({ id: k.id, type: "KeyStep", label: k.label, raw: k });
  for (const i of p.instructions)
    nodes.push({ id: i.id, type: "Instruction", label: i.label, raw: i });
  for (const a of p.expertAdvice)
    nodes.push({ id: a.id, type: "ExpertAdvice", label: a.label, raw: a });
  for (const t of p.tools)
    nodes.push({ id: t.id, type: "Tool", label: t.label, raw: t });
  for (const part of p.parts)
    nodes.push({ id: part.id, type: "Part", label: part.label, raw: part });
  return nodes;
}

const TYPE_BIAS: Record<string, number> = {
  ExpertAdvice: 1.5,
  Instruction: 1.2,
  KeyStep: 1.1,
  Tool: 1.0,
  Part: 1.0,
  ProceduralActivity: 0.5,
};

export function retrieveRelevantNodes(
  procedure: ProcedureSpec,
  query: string,
  k = 6,
): GraphNode[] {
  const nodes = flattenProcedure(procedure);
  const terms = query
    .toLowerCase()
    .split(/[^\w]+/)
    .filter((s) => s.length > 2);
  if (terms.length === 0) return nodes.slice(0, k);
  const scored = nodes.map((n) => {
    const blob = `${n.label} ${JSON.stringify(n.raw)}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const hits = blob.split(t).length - 1;
      if (hits > 0) score += hits;
    }
    score *= TYPE_BIAS[n.type] ?? 1.0;
    return { n, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.n);
}
