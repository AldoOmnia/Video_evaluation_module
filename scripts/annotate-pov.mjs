#!/usr/bin/env node
/**
 * One-shot POV pre-annotation (digital twin "AI interpretation" layer).
 *
 * Samples the worker-POV walkthrough at 1 frame / 5 s, sends each frame to
 * Gemini (same vision models as the glasses observe loop) together with the
 * station's 12-step procedure and component fingerprints from the live KB,
 * and writes a smoothed, timestamped annotation timeline that the digital
 * twin viewer overlays at zero runtime cost (Cosmos-style caption card).
 *
 * Usage:
 *   node scripts/annotate-pov.mjs                       # defaults below
 *   node scripts/annotate-pov.mjs --video path.mp4 --interval 5
 *
 * Requires: ffmpeg on PATH, backend running on :3001 (for the KB),
 * GEMINI_API_KEY in backend/.env or the environment.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── args / config ─────────────────────────────────────────────────── */
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const VIDEO = resolve(ROOT, arg("video", "eval-lab/public/assets/phase8_pov.mp4"));
const INTERVAL_S = Number(arg("interval", 5));
const OUT = resolve(ROOT, arg("out", "eval-lab/public/assets/phase8-pov-annotations.json"));
const KB_URL = arg("kb", "http://localhost:3001/api/kb/stations/pg-04");
const MODEL = arg("model", "gemini-3.5-flash");
const FALLBACK_MODEL = "gemini-2.5-flash";

/* ── Gemini key (backend/.env or env) ──────────────────────────────── */
let KEY = (process.env.GEMINI_API_KEY ?? "").trim();
if (!KEY) {
  try {
    const env = readFileSync(join(ROOT, "backend", ".env"), "utf8");
    KEY = (env.match(/^GEMINI_API_KEY=(.+)$/m)?.[1] ?? "").trim();
  } catch { /* no .env */ }
}
if (!KEY) {
  console.error("GEMINI_API_KEY not found (env or backend/.env) — aborting.");
  process.exit(1);
}

/* ── station knowledge for the prompt ──────────────────────────────── */
const kb = await (await fetch(KB_URL)).json();
const steps = (kb.keysteps ?? [])
  .sort((a, b) => a.order - b.order)
  .map((s) => `${s.order}. ${s.label}`)
  .join("\n");
const components = (kb.components ?? [])
  .map((c) => `- ${c.name}${c.steps?.length ? ` (used in ${c.steps.join(", ")})` : ""}`)
  .join("\n");

const BASE_PROMPT = `You are the AI reasoner for the Comer Industries digital twin.
The image is ONE frame from a worker point-of-view walkthrough recorded at
station ST100 · Pinion Guide (PG-04) — pinion cover pre-assembly. The wearer
walks the station, so many frames show walking, machine fronts, UNICOMM MES
touchscreens, benches or parts bins rather than active assembly work.

The station's procedure (12 ordered key steps):
${steps}

Catalogue components at this station:
${components}

For THIS frame return ONLY raw JSON (no markdown) with:
{
  "caption": string,      // 1-2 short present-tense sentences: what the camera sees
  "step": number|null,    // 1-12 ONLY if that step is visibly being performed, else null
  "observed": string[],   // catalogue components clearly visible (short names), else []
  "deviation": string|null, // anything contradicting the procedure/safety, else null
  "confidence": number    // 0-1 for the step judgment
}
Be conservative: walking / looking at screens / idle benches → step null.`;

/* ── frame extraction ──────────────────────────────────────────────── */
const tmp = mkdtempSync(join(tmpdir(), "pov-frames-"));
console.log(`Extracting 1 frame / ${INTERVAL_S}s from ${VIDEO} …`);
execFileSync("ffmpeg", [
  "-loglevel", "error", "-i", VIDEO,
  "-vf", `fps=1/${INTERVAL_S},scale=896:-2`,
  "-q:v", "5", join(tmp, "f_%04d.jpg"),
]);
const frames = readdirSync(tmp).filter((f) => f.endsWith(".jpg")).sort();
console.log(`${frames.length} frames extracted.`);

/* ── Gemini per-frame calls ────────────────────────────────────────── */
async function callGemini(model, jpegB64, t) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: BASE_PROMPT },
            { text: `FRAME at t=${t}s of the walkthrough:` },
            { inline_data: { mime_type: "image/jpeg", data: jpegB64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 400,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
  const clean = text.replace(/```(?:json)?/g, "").trim();
  return JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
for (let i = 0; i < frames.length; i++) {
  const t = i * INTERVAL_S;
  const b64 = readFileSync(join(tmp, frames[i])).toString("base64");
  let ann = null;
  for (const model of [MODEL, FALLBACK_MODEL]) {
    try { ann = { ...(await callGemini(model, b64, t)), model }; break; }
    catch (e) { console.warn(`  t=${t}s ${model} failed: ${e.message}`); }
  }
  if (!ann) { console.warn(`  t=${t}s SKIPPED (both models failed)`); continue; }
  out.push({
    t,
    caption: String(ann.caption ?? "").slice(0, 300),
    step: Number.isInteger(ann.step) && ann.step >= 1 && ann.step <= 12 ? ann.step : null,
    observed: Array.isArray(ann.observed) ? ann.observed.map(String).slice(0, 5) : [],
    deviation: ann.deviation ? String(ann.deviation).slice(0, 200) : null,
    confidence: Math.max(0, Math.min(1, Number(ann.confidence ?? 0))),
  });
  console.log(`  t=${String(t).padStart(3)}s step=${out.at(-1).step ?? "—"} ${out.at(-1).caption.slice(0, 80)}`);
  await sleep(250);
}

/* ── sequence smoothing ────────────────────────────────────────────────
   A step reading confirmed by only a single frame (its step-bearing
   neighbors disagree) is VLM jitter — demote it to an observation
   (step null) but keep the caption. Runs of >= 2 agreeing frames stay. */
const stepped = out.filter((f) => f.step != null);
const orig = stepped.map((f) => f.step);
stepped.forEach((f, i) => {
  const confirmed = orig[i - 1] === orig[i] || orig[i + 1] === orig[i];
  if (!confirmed) f.step = null;
});

const stepLabels = Object.fromEntries((kb.keysteps ?? []).map((s) => [s.order, s.label]));
for (const f of out) if (f.step != null) f.stepLabel = stepLabels[f.step] ?? null;

writeFileSync(OUT, JSON.stringify({
  video: "phase8_pov.mp4",
  station: "pg-04",
  stationLabel: "ST100 · Pinion Guide",
  generatedAt: new Date().toISOString(),
  model: MODEL,
  intervalS: INTERVAL_S,
  frames: out,
}, null, 1));
rmSync(tmp, { recursive: true, force: true });
console.log(`\nWrote ${out.length} annotations → ${OUT}`);
