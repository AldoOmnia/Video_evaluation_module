/**
 * Import reviewed GlassKit eval artifacts into the portal contracts.
 *
 * The glasses repo (comer-rokid-demo/backend/eval, branch vision-eval / #61)
 * is the source of truth for recorded-video labels. This file is the sink:
 * it validates what that exporter wrote against VideoSegmentSchema /
 * SessionEventSchema so a bad CSV cannot silently poison /api/eval or the
 * Brain graph.
 *
 *   npm run import:glasskit
 *   npx tsx annotation-pipeline/src/from-glasskit.ts \
 *     --csv annotation-pipeline/data/incoming/video-index.csv \
 *     --json annotation-pipeline/data/incoming/session-events.json \
 *     --out annotation-pipeline/data/labeled
 *
 * Validated JSON is written to --out. The same files, plus the source
 * video-index.csv, are also published to eval-lab/public/glasskit so
 * /vision-cases/ and /lab/glasskit/ serve this import.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SessionEventSchema,
  VideoSegmentSchema,
  type SessionEvent,
  type VideoSegment,
} from "../../shared/types/events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, "../data/labeled");
const DEFAULT_CSV = resolve(HERE, "../data/incoming/video-index.csv");
const DEFAULT_JSON = resolve(HERE, "../data/incoming/session-events.json");
/** What `express.static` on eval-lab/public exposes at /lab/glasskit/. */
const SERVED_DIR = resolve(HERE, "../../eval-lab/public/glasskit");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (c === '"') {
        quoted = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function segmentsFromCsv(rows: Record<string, string>[]): VideoSegment[] {
  const segments: VideoSegment[] = [];
  rows.forEach((row, i) => {
    const file = (row.video_file || "").trim();
    const stepId = (row.step_id || "").trim();
    const label = (row.label || "").trim().toLowerCase();
    if (!file || !stepId) return;
    if (!["correct", "incorrect", "ambiguous"].includes(label)) return;
    const start = Number(row.start_s || 0) || 0;
    const end = Number(row.end_s || start);
    const errorType = (row.error_type || "").trim().toUpperCase();
    const parsed = VideoSegmentSchema.safeParse({
      id: `vid:${file.replace(/\W+/g, "-")}-${stepId}-${i}`,
      type: "VideoSegment",
      label: `${file} → ${stepId} (${label})`,
      fileName: file,
      timestampStart: start,
      timestampEnd: Math.max(end, start),
      errorType: errorType || undefined,
      isCorrectExecution: label === "correct",
      attachedTo: stepId,
    });
    if (!parsed.success) {
      throw new Error(
        `video-index row ${i + 1} failed VideoSegmentSchema: ${parsed.error.message}`,
      );
    }
    segments.push(parsed.data);
  });
  return segments;
}

function eventsFromJson(raw: unknown): SessionEvent[] {
  const payload = raw as { events?: unknown };
  if (!Array.isArray(payload?.events)) {
    throw new Error("session-events.json must have an events[] array");
  }
  return payload.events.map((ev, i) => {
    const parsed = SessionEventSchema.safeParse(ev);
    if (!parsed.success) {
      throw new Error(`events[${i}] failed SessionEventSchema: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

const csvPath = resolve(arg("--csv") || DEFAULT_CSV);
const jsonPath = resolve(arg("--json") || DEFAULT_JSON);
const outDir = resolve(arg("--out") || DEFAULT_OUT);

const segments = segmentsFromCsv(parseCsv(readFileSync(csvPath, "utf8")));
const events = eventsFromJson(JSON.parse(readFileSync(jsonPath, "utf8")));

const segmentsJson = `${JSON.stringify(segments, null, 2)}\n`;
const eventsJson = `${JSON.stringify(events, null, 2)}\n`;
for (const dir of new Set([outDir, SERVED_DIR])) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "video-segments.json"), segmentsJson);
  writeFileSync(resolve(dir, "session-events.json"), eventsJson);
}

const servedCsv = resolve(SERVED_DIR, "video-index.csv");
if (resolve(csvPath) !== servedCsv) copyFileSync(csvPath, servedCsv);

console.log(
  `imported ${segments.length} VideoSegment(s), ${events.length} SessionEvent(s) → ${outDir} (served ${SERVED_DIR})`,
);
