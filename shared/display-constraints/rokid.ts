/**
 * Display constraint enforcement for Rokid AI Glasses (and similar).
 *
 * The lens shows up to 4 lines. The Rokid APK's `QueryResult` is
 * { line1, line2, line3, line4 } and the on-device AnswerCard renders
 * each line at a distinct font size with a distinct semantic role:
 *
 *   line1 — small dim-teal LABEL    (10sp, ~32 chars)
 *   line2 — large white VALUE       (22sp, ~16 chars)  ← the headline
 *   line3 — teal corrective ACTION  (14sp, ~28 chars)
 *   line4 — small gray SOURCE/NEXT  (10sp, ~32 chars)
 *
 * This module is the *one* place that fits arbitrary LLM text into
 * that shape, both for the production runtime and for the eval lab's
 * "would this actually be readable on glass" metric.
 */
import type {
  DisplayConstraint,
  FourRoleBudget,
  HardwareProfile,
} from "../types/hardware";

export interface FormattedDisplay {
  lines: [string, string, string, string];
  truncated: boolean;
  /** Heuristic 0..1 — would a worker actually be able to glance and act? */
  glanceability: number;
}

/** Role-tagged 4-line lens output. Mirrors the AnswerCard.kt schema. */
export interface FourRoleDisplay {
  label: string;
  value: string;
  action: string;
  source: string;
  lines: [string, string, string, string];
  truncated: boolean;
  glanceability: number;
}

export const ROKID_FOUR_ROLE: FourRoleBudget = {
  label_chars: 32,
  value_chars: 16,
  action_chars: 36,
  source_chars: 32,
};

export const ROKID_DEFAULT: DisplayConstraint = {
  max_lines: 4,
  max_chars_per_line: 16,
  max_total_chars: 110,
  rich_formatting: false,
  four_role_budget: ROKID_FOUR_ROLE,
};

export function getConstraint(hw: HardwareProfile): DisplayConstraint {
  return hw.display ?? ROKID_DEFAULT;
}

/**
 * Convert arbitrary LLM text → 4-line display. Greedy word-wrap, then
 * truncate. Never throws; always returns four strings.
 */
export function fitToDisplay(
  raw: string,
  hw: HardwareProfile = { ...stubRokid(), display: ROKID_DEFAULT },
): FormattedDisplay {
  const c = getConstraint(hw);
  const stripped = raw
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = stripped.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (lines.length >= c.max_lines) break;
    if (current.length === 0) {
      current = w.slice(0, c.max_chars_per_line);
      continue;
    }
    if (current.length + 1 + w.length <= c.max_chars_per_line) {
      current = `${current} ${w}`;
    } else {
      lines.push(current);
      current = w.slice(0, c.max_chars_per_line);
    }
  }
  if (lines.length < c.max_lines && current) lines.push(current);
  while (lines.length < c.max_lines) lines.push("");

  const truncated =
    stripped.length > c.max_total_chars ||
    lines.join(" ").trim().length < stripped.length;

  // Glanceability heuristic — penalise truncation and over-density.
  const dens = lines.join(" ").trim().length / Math.max(1, stripped.length);
  const glanceability = Math.max(0, Math.min(1, dens - (truncated ? 0.15 : 0)));

  return {
    lines: [lines[0] ?? "", lines[1] ?? "", lines[2] ?? "", lines[3] ?? ""],
    truncated,
    glanceability,
  };
}

/** Score a candidate LLM response for display feasibility (used by eval lab). */
export function scoreDisplay(raw: string, hw: HardwareProfile): number {
  return fitToDisplay(raw, hw).glanceability;
}

export function getFourRoleBudget(hw: HardwareProfile): FourRoleBudget {
  return hw.display?.four_role_budget ?? ROKID_FOUR_ROLE;
}

export function optimizeLensRoles(
  parts: { label?: string; value?: string; action?: string; source?: string },
  hints?: {
    detected?: boolean;
    errorCode?: string | null;
    fix?: string;
    diagnosis?: string;
  },
): { label: string; value: string; action: string; source: string } {
  let label = clean(parts.label ?? "");
  let value = clean(parts.value ?? "");
  let action = clean(parts.action ?? "");
  const source = clean(parts.source ?? "");

  if (!hints?.detected) return { label, value, action, source };

  const code = hints.errorCode ?? "";
  const fix = clean(hints.fix ?? "");
  const diag = clean(hints.diagnosis ?? "");
  const blob = `${diag} ${action} ${fix}`.toLowerCase();

  if (!label && code) label = code.replace(/_/g, " ");

  // VALUE = large headline (≤16 chars) — the error fact, not the imperative.
  const valueTooLong = value.length > 18;
  const valueIsPreamble = /^stop\b|^verify\b/i.test(value);
  if (!value || valueTooLong || valueIsPreamble) {
    if (/shim|sku/.test(blob) || code === "SUBSTITUTION") {
      value = "WRONG SHIM SKU";
    } else if (code === "ORIENTATION") {
      value = "WRONG ORIENTATION";
    } else if (code === "UNVERIFIED") {
      value = "NOT VERIFIED";
    } else if (code === "OUT_OF_SPEC") {
      value = "OUT OF SPEC";
    } else if (diag) {
      value = diag.split(/[—.;,]/)[0]?.trim() ?? value;
    }
  }

  // ACTION = short imperative — never a long "Stop — verify …" preamble.
  if (/^stop\s*[—–-]/i.test(action) || action.length > 34) {
    if (fix && fix.length <= 40) {
      action = fix.split(/[.;]/)[0]?.trim() ?? fix;
    } else if (/shim|sku/.test(blob)) {
      action = "Check SKU vs traveler";
    } else {
      action = action
        .replace(/^stop\s*[—–-]\s*/i, "")
        .replace(/^please\s+/i, "")
        .replace(/^verify\s+/i, "Check ");
    }
  }
  if (action.length > 44) {
    action = action.split(/[.;]/)[0]?.trim() ?? action;
  }

  return { label, value, action, source };
}

/**
 * Fit four arbitrary role strings into the AnswerCard 4-line layout.
 * Each role gets its own char budget so the small LABEL/SOURCE roles
 * never bleed into the big VALUE role's budget. Returned `lines` is
 * the same 4-tuple the legacy renderer expects (line1..line4).
 */
export function fitFourRole(
  parts: { label?: string; value?: string; action?: string; source?: string },
  hw: HardwareProfile = { ...stubRokid(), display: ROKID_DEFAULT },
): FourRoleDisplay {
  const b = getFourRoleBudget(hw);
  const label = clean(parts.label ?? "");
  const value = clean(parts.value ?? "");
  const action = clean(parts.action ?? "");
  const source = clean(parts.source ?? "");

  const labelLine = wrapFirst(label, b.label_chars);
  const valueLine = wrapFirst(value, b.value_chars);
  const actionLine = fitActionLine(action, b.action_chars);
  const sourceLine = wrapFirst(source, b.source_chars);

  const total = label.length + value.length + action.length + source.length;
  const fit =
    labelLine.length + valueLine.length + actionLine.length + sourceLine.length;
  const truncated = fit < total;
  const glanceability = Math.max(0, Math.min(1, fit / Math.max(1, total)));

  return {
    label: labelLine,
    value: valueLine,
    action: actionLine,
    source: sourceLine,
    lines: [labelLine, valueLine, actionLine, sourceLine],
    truncated,
    glanceability,
  };
}

/** Action line keeps the tail ("vs traveler") when space is tight. */
function fitActionLine(s: string, maxChars: number): string {
  if (!s) return "";
  if (s.length <= maxChars) return s;

  let t = s.replace(/^stop\s*[—–-]\s*/i, "").replace(/^please\s+/i, "");
  if (t.length <= maxChars) return t;

  const vsMatch = t.match(/\bvs\.?\s+(.+)$/i);
  if (vsMatch) {
    const tail = `vs ${vsMatch[1].trim()}`;
    if (tail.length <= maxChars) {
      const head = t.slice(0, t.length - vsMatch[0].length).trim();
      const headBudget = maxChars - tail.length - 1;
      if (headBudget >= 6) {
        const headFit = wrapFirst(head, headBudget);
        const combined = `${headFit} ${tail}`;
        return combined.length <= maxChars ? combined : tail.slice(0, maxChars);
      }
      return tail.slice(0, maxChars);
    }
  }

  const wrapped = wrapFirst(t, maxChars);
  if (wrapped.length < t.length && maxChars > 1) {
    return wrapped.length >= maxChars ? wrapped : `${wrapped.slice(0, maxChars - 1)}…`;
  }
  return wrapped;
}

/** Greedy first-line word-wrap; ensures no mid-word slicing. */
function wrapFirst(s: string, maxChars: number): string {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const words = s.split(" ");
  let line = "";
  for (const w of words) {
    if (line.length === 0) {
      // If a single word exceeds the cap, hard-trim it — nothing we can do.
      line = w.length > maxChars ? w.slice(0, maxChars) : w;
      continue;
    }
    if (line.length + 1 + w.length <= maxChars) line = `${line} ${w}`;
    else break;
  }
  return line;
}

function clean(s: string): string {
  return s.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Best-effort coercion of an LLM response shape into the 4 role strings.
 * Accepts:
 *   - object with {label,value,action,source}
 *   - array of 1..4 strings (interpreted positionally)
 *   - object with line1..line4 keys
 *   - a single string (split by newlines, falls back to fitToDisplay)
 */
export function coerceFourRole(
  src: unknown,
  fallbackText = "",
): { label: string; value: string; action: string; source: string } {
  const empty = { label: "", value: "", action: "", source: "" };
  if (!src) {
    return parseFromText(fallbackText, empty);
  }
  if (Array.isArray(src)) {
    return {
      label: String(src[0] ?? ""),
      value: String(src[1] ?? ""),
      action: String(src[2] ?? ""),
      source: String(src[3] ?? ""),
    };
  }
  if (typeof src === "object") {
    const o = src as Record<string, unknown>;
    if ("label" in o || "value" in o || "action" in o || "source" in o) {
      return {
        label: String(o.label ?? ""),
        value: String(o.value ?? ""),
        action: String(o.action ?? ""),
        source: String(o.source ?? ""),
      };
    }
    if ("line1" in o || "line2" in o || "line3" in o || "line4" in o) {
      return {
        label: String(o.line1 ?? ""),
        value: String(o.line2 ?? ""),
        action: String(o.line3 ?? ""),
        source: String(o.line4 ?? ""),
      };
    }
  }
  if (typeof src === "string") {
    return parseFromText(src, empty);
  }
  return empty;
}

function parseFromText(
  text: string,
  empty: { label: string; value: string; action: string; source: string },
): { label: string; value: string; action: string; source: string } {
  if (!text) return empty;
  const lines = text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    label: lines[0] ?? "",
    value: lines[1] ?? "",
    action: lines[2] ?? "",
    source: lines[3] ?? "",
  };
}

function stubRokid(): HardwareProfile {
  return {
    id: "rokid_ai",
    name: "Rokid AI Glasses",
    desc: "stub",
    signals: {
      eye_gaze: false,
      camera: true,
      display: true,
      hand_track: false,
      audio_in: true,
      audio_out: true,
    },
    dwell_threshold_ms: 800,
    latency_budget_ms: 200,
    display: ROKID_DEFAULT,
  };
}
