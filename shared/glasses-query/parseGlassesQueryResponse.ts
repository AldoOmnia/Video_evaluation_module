import type { FourRoleLens } from "../types/events.js";

export interface GlassesQueryParsed {
  lens: FourRoleLens;
  labBrief: { headline: string; bullets: string[] };
  isAction: boolean;
  rawText: string;
}

export function parseGlassesQueryResponse(text: string): GlassesQueryParsed {
  const stripped = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const candidates = extractJsonObjects(stripped);
  let best: GlassesQueryParsed | null = null;
  let bestScore = -1;

  for (const obj of candidates) {
    const lens = coerceLens(obj.glassesMessage ?? obj.lens);
    const labBrief = coerceLabBrief(obj.labBrief);
    const isAction = !!obj.isAction;
    const score =
      (lens.label ? 1 : 0) +
      (lens.value ? 2 : 0) +
      (lens.action ? 1 : 0) +
      (labBrief.headline ? 2 : 0) +
      (labBrief.bullets.length > 0 ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { lens, labBrief, isAction, rawText: text };
    }
  }

  if (best) return best;

  // Fallback: treat raw text as headline, generic lens
  const flat = stripped.slice(0, 200);
  return {
    lens: {
      label: "INFO",
      value: flat.slice(0, 16),
      action: "See lab detail",
      source: "Brain response",
    },
    labBrief: { headline: flat, bullets: [] },
    isAction: false,
    rawText: text,
  };
}

function coerceLens(src: unknown): FourRoleLens {
  if (src && typeof src === "object" && !Array.isArray(src)) {
    const o = src as Record<string, unknown>;
    return {
      label: String(o.label ?? o.line1 ?? "").trim(),
      value: String(o.value ?? o.line2 ?? "").trim(),
      action: String(o.action ?? o.line3 ?? "").trim(),
      source: String(o.source ?? o.line4 ?? "").trim(),
    };
  }
  if (Array.isArray(src)) {
    const [a, b, c, d] = src.map((x) => String(x ?? ""));
    return { label: a, value: b, action: c, source: d };
  }
  return { label: "", value: "", action: "", source: "" };
}

function coerceLabBrief(src: unknown): { headline: string; bullets: string[] } {
  if (src && typeof src === "object" && !Array.isArray(src)) {
    const o = src as Record<string, unknown>;
    const bullets = Array.isArray(o.bullets)
      ? o.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      headline: String(o.headline ?? o.summary ?? "").trim().slice(0, 240),
      bullets,
    };
  }
  return { headline: "", bullets: [] };
}

function extractJsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>);
        } catch {
          /* skip */
        }
        start = -1;
      }
    }
  }
  return out;
}
