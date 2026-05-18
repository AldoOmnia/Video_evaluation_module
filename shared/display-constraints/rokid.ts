/**
 * Display constraint enforcement for Rokid AI Glasses (and similar).
 *
 * The lens shows up to 4 lines × ~22 chars. The Rokid APK's `QueryResult`
 * is { line1, line2, line3, line4 }. This module is the *one* place that
 * fits arbitrary LLM text into that shape, both for the production runtime
 * and for the eval lab "would this actually be readable on glass" metric.
 */
import type { DisplayConstraint, HardwareProfile } from "../types/hardware";

export interface FormattedDisplay {
  lines: [string, string, string, string];
  truncated: boolean;
  /** Heuristic 0..1 — would a worker actually be able to glance and act? */
  glanceability: number;
}

export const ROKID_DEFAULT: DisplayConstraint = {
  max_lines: 4,
  max_chars_per_line: 22,
  max_total_chars: 88,
  rich_formatting: false,
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
