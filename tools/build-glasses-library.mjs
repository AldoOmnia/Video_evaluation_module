#!/usr/bin/env node
/**
 * Builds the clip library of the glasses preview (Digital Twin, top-right
 * quadrant): a few station clips that open with the page, each with the reads
 * already made, so the panel can be watched without uploading anything.
 *
 *   node tools/build-glasses-library.mjs <path to comer-rokid-demo> \
 *        [--base http://localhost:3012] [--ref origin/vision-eval] [--only id,id]
 *
 * The footage is the glasses repo's own: the station clips its orientation
 * model was trained on (ml/datasets/pinion-station/raw-videos, gitignored
 * there). They are only read. What each clip is (part, pose, session, split)
 * is taken from that repo's manifest at the given ref, not typed in here.
 *
 * For every entry below this:
 *   1. cuts and transcodes the source to a small H.264 file under
 *      eval-lab/public/assets/glasses-clips/
 *   2. takes frames from THAT file at the glasses' read cadence, the way the
 *      page does, and has the running portal read them (POST /api/pov/observe)
 *      once in English and once in Italian
 *   3. writes the reads next to the clip in shared/data/glasses-library.json
 *
 * The reads are kept so the library opens instantly and shows the same thing
 * every time; a read varies a little from run to run. Only the reads are
 * kept: the guards are replayed by the server whenever a clip is opened, so
 * the thresholds in force are always the current ones.
 *
 * Needs ffmpeg and ffprobe on the PATH, and the portal running with vision
 * configured.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "eval-lab", "public", "assets", "glasses-clips");
const OUT_JSON = join(ROOT, "shared", "data", "glasses-library.json");

/**
 * The library. Which clips, which stretch of each and where two are joined
 * are choices made by hand, here. `shows` says what the footage is, going by
 * how the corpus labels it; it says nothing about what gets read.
 *
 * A corpus clip is all one pose, so the only way to see a card come down on
 * corpus footage is to follow a wrong-way-up clip with the right-way-up clip
 * of the same part. Those entries take the first 15 s of each, are marked as
 * joined, and the page marks the join on the scrubber.
 *
 * Left out on purpose, as measured on 2026-11-15 with the reader as it was:
 *   - Step 4 (cone 248118A1): its right-way-up clip is read as flipped about
 *     as often as its wrong-way-up one, so a card on that step would be right
 *     by accident.
 *   - The line recordings the glasses' eval cases score against: the part is
 *     small and far in them and the reads do not repeat. Seven reads of the
 *     same 40 s of Phase6_Video.MP4 put the card up at the flipped cone in
 *     five and never in two. Kept reads would be one draw out of those.
 */
const CLIPS = [
  {
    id: "s6-cone-67190r91-wrong-then-correct",
    step: 6,
    sku: "67190R91",
    shows: "wrong_then_correct",
    parts: [
      { corpus: "Bearing_cone_67190R91_STATION_WRONG/bearing_cone_67190r91_station_wrong", start: 0, seconds: 15 },
      { corpus: "Bearing_cone_67190R91_STATION_CORRECT/bearing_cone_67190r91_station_correct", start: 0, seconds: 15 },
    ],
  },
  {
    id: "s1-cup-248114a1-wrong-then-correct",
    step: 1,
    sku: "248114A1",
    shows: "wrong_then_correct",
    parts: [
      { corpus: "Bearing_cup_248114A1_STATION_WRONG/bearing_cup_248114a1_station_wrong", start: 0, seconds: 15 },
      { corpus: "Bearing_cup_248114A1_STATION_CORRECT/bearing_cup_248114a1_station_correct", start: 0, seconds: 15 },
    ],
  },
  {
    id: "s2-cup-191440a1-wrong-then-correct",
    step: 2,
    sku: "191440A1",
    shows: "wrong_then_correct",
    parts: [
      { corpus: "Bearing_cup_191440A1_STATION_WRONG/bearing_cup_191440a1_station_wrong", start: 0, seconds: 15 },
      { corpus: "Bearing_cup_191440A1_STATION_CORRECT/bearing_cup_191440a1_station_correct", start: 0, seconds: 15 },
    ],
  },
  {
    id: "s1-cup-248114a1-wrong",
    step: 1,
    sku: "248114A1",
    shows: "wrong",
    parts: [{ corpus: "Bearing_cup_248114A1_STATION_WRONG/bearing_cup_248114a1_station_wrong" }],
  },
  {
    id: "s6-cone-67190r91-correct",
    step: 6,
    sku: "67190R91",
    shows: "correct",
    parts: [{ corpus: "Bearing_cone_67190R91_STATION_CORRECT/bearing_cone_67190r91_station_correct" }],
  },
];

/* ── arguments ───────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const repo = argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : null;
const base = flag("base", "http://localhost:3012").replace(/\/$/, "");
const ref = flag("ref", "origin/vision-eval");
const only = flag("only", "").split(",").filter(Boolean);
if (!repo) {
  console.error("usage: node tools/build-glasses-library.mjs <path to comer-rokid-demo> [--base url] [--ref git-ref] [--only id,id]");
  process.exit(2);
}

const CORPUS = join(repo, "ml", "datasets", "pinion-station", "raw-videos");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 1 << 28, ...opts });
const git = (...args) => run("git", ["-C", repo, ...args]).toString();
const die = (msg) => { console.error(`build-glasses-library: ${msg}`); process.exit(1); };

/* ── what the glasses repo says each corpus clip is ──────────────────── */

/** clip_id → its manifest row. The file has no quoted commas. */
function corpusManifest() {
  const rows = git("show", `${ref}:ml/datasets/pinion-station/manifest.csv`).trim().split(/\r?\n/);
  const head = rows.shift().split(",");
  const out = new Map();
  for (const line of rows) {
    const cells = line.split(",");
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
    out.set(row.clip_id, row);
  }
  return out;
}

function corpusFile(clipId) {
  for (const ext of [".MOV", ".mov", ".mp4", ".MP4"]) {
    const p = join(CORPUS, clipId + ext);
    if (existsSync(p)) return p;
  }
  die(`corpus clip not on disk: ${join(CORPUS, clipId)}.*`);
}

/* ── the portal ──────────────────────────────────────────────────────── */

async function api(path, body) {
  const init = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined;
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(base + path, init);
      break;
    } catch (e) {
      // Transcoding the next clip takes longer than the server keeps an idle
      // connection open, and a POST on the stale one is not retried for us.
      if (attempt >= 3) die(`${path} could not be reached: ${e.cause?.message || e.message}`);
    }
  }
  if (!res.ok) die(`${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* ── video ───────────────────────────────────────────────────────────── */

const probe = (file, entries) =>
  run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "json", file]).toString();

function transcode(sources, outFile) {
  const args = ["-loglevel", "error", "-y"];
  sources.forEach((s) => {
    if (s.start != null) args.push("-ss", String(s.start));
    if (s.seconds != null) args.push("-t", String(s.seconds));
    args.push("-i", s.file);
  });
  // 960 wide for a landscape clip, 540 for a portrait one. The page reads
  // frames at 640 wide at most, so this is for watching, not for the reads.
  const chain = sources
    .map((_, i) => `[${i}:v]scale='if(gt(iw,ih),960,540)':-2,setsar=1,fps=30,format=yuv420p[v${i}]`)
    .join(";");
  const filter = sources.length > 1
    ? `${chain};${sources.map((_, i) => `[v${i}]`).join("")}concat=n=${sources.length}:v=1:a=0[v]`
    : chain.replace(/\[v0\]$/, "[v]");
  args.push(
    "-filter_complex", filter, "-map", "[v]", "-an",
    "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-movflags", "+faststart", outFile,
  );
  run("ffmpeg", args);
}

/** One JPEG at t, sized as the page sizes the frames it takes. */
const frameAt = (file, t) =>
  run("ffmpeg", [
    "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", "scale='min(640,iw)':-2", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
  ]).toString("base64");

/* ── build ───────────────────────────────────────────────────────────── */

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const spec = await api("/api/pov/glasses");
if (!spec.ready) die("vision is not configured on the portal at " + base);
const cadence = spec.cadenceMs / 1000;
const manifest = corpusManifest();
const commit = git("rev-parse", ref).trim();
const guards = JSON.parse(readFileSync(join(ROOT, "shared", "data", "glasses-guards-st100.json"), "utf8"));
mkdirSync(OUT_DIR, { recursive: true });

const previous = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, "utf8")) : { clips: [] };
const built = [];

for (const entry of CLIPS) {
  if (only.length && !only.includes(entry.id)) {
    const kept = previous.clips.find((c) => c.id === entry.id);
    if (kept) built.push(kept);
    continue;
  }
  console.log(`\n${entry.id}`);

  let at = 0;
  const parts = [];
  const sources = entry.parts.map((p) => {
    const row = manifest.get(p.corpus);
    if (!row) die(`${p.corpus} is not in the corpus manifest at ${ref}`);
    if (row.sku !== entry.sku) die(`${p.corpus} is ${row.sku} in the manifest, not ${entry.sku}`);
    const file = corpusFile(p.corpus);
    const described = { clip: p.corpus, pose: row.pose, split: row.split, sessionDate: row.session_date || null };
    const whole = Number(JSON.parse(probe(file, "format=duration")).format.duration);
    const start = p.start ?? 0;
    const seconds = Math.min(p.seconds ?? whole - start, whole - start);
    parts.push({ ...described, start, seconds: Number(seconds.toFixed(2)), whole: p.seconds == null, at: Number(at.toFixed(2)) });
    at += seconds;
    return { file, start: p.start, seconds: p.seconds };
  });

  const file = `${entry.id}.mp4`;
  const outFile = join(OUT_DIR, file);
  transcode(sources, outFile);
  const meta = JSON.parse(probe(outFile, "stream=width,height:format=duration"));
  const duration = Number(Number(meta.format.duration).toFixed(2));
  const sha = createHash("sha256").update(readFileSync(outFile)).digest("hex").slice(0, 10);
  console.log(`  ${file}  ${duration}s  ${meta.streams[0].width}x${meta.streams[0].height}  ${(statSync(outFile).size / 1048576).toFixed(2)} MB`);

  // The same times the page reads a clip at: from the start, one cadence apart.
  const times = [];
  for (let i = 0; i < 4 * spec.framesPerCall; i++) {
    const t = i * cadence;
    if (t > duration - 0.05) break;
    times.push(Math.max(0.05, t));
  }
  const frames = times.map((t) => ({ t: Number(t.toFixed(2)), dataBase64: frameAt(outFile, t) }));

  const observe = async (lang) => {
    const reads = [];
    let model = null, references = null, pinned = null;
    for (let c = 0; c < frames.length; c += spec.framesPerCall) {
      const d = await api("/api/pov/observe", { clip: entry.id, step: entry.step, lang, frames: frames.slice(c, c + spec.framesPerCall) });
      if (d.stubbed) die(d.note || "the portal did not read the frames");
      reads.push(...d.reads);
      ({ model, references, pinned } = d);
    }
    return { reads, model, references, pinned };
  };
  const en = await observe("en");
  const it = await observe("it");
  // The Italian pass is a second read of the same frame and can come out
  // differently. Its wording is only kept where it describes the same verdict.
  let italian = 0;
  const reads = en.reads.map((r, i) => {
    const o = it.reads[i];
    const same = o && o.answered && o.sku === r.sku && o.pose === r.pose && o.hands === r.hands;
    if (same) italian += 1;
    return same ? { ...r, it: { caption: o.caption, reasoning: o.reasoning, scene: o.scene } } : r;
  });

  const panel = await api("/api/pov/panel", {
    step: entry.step,
    endT: Math.min(duration, times.length * cadence),
    reads: reads.map((r) => ({ t: r.t, sku: r.sku, className: r.className, confidence: r.confidence, pose: r.pose, scene: r.scene })),
  });
  const mark = (r) => (!r.answered ? "?" : r.hands ? "h" : r.pose === "wrong" ? "F" : r.pose === "correct" ? "c" : r.pose === "unclear" ? "u" : r.sku ? "o" : "-");
  console.log(`  ${reads.length} reads (${italian} with Italian wording): ${reads.map(mark).join("")}`);
  console.log(`  card: ${panel.events.map((e) => `${e.t.toFixed(1)}s ${e.kind === "raise" ? "up" : "down"} (${e.code})`).join(", ") || "never up"}`);

  built.push({
    id: entry.id,
    file,
    sha,
    bytes: statSync(outFile).size,
    duration,
    width: meta.streams[0].width,
    height: meta.streams[0].height,
    step: entry.step,
    sku: entry.sku,
    shows: entry.shows,
    parts,
    readsMadeOn: localDate(),
    model: en.model,
    references: en.references,
    pinned: en.pinned,
    reads,
  });
}

writeFileSync(OUT_JSON, JSON.stringify({
  _source: {
    note: "Generated by tools/build-glasses-library.mjs. Footage from the glasses repo's training corpus; what each clip is comes from that repo's corpus manifest. The reads were made by this portal from the transcoded files.",
    repo: guards._source.repo,
    ref,
    commit,
    builtOn: localDate(),
  },
  cadenceMs: spec.cadenceMs,
  clips: built,
}, null, 2) + "\n");
console.log(`\nwrote ${OUT_JSON} (${built.length} clips)`);
