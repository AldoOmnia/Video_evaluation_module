#!/usr/bin/env node
/**
 * Play one glasses recording through the Emotiv stack and keep what it said.
 *
 *   node tools/emotiv-replay/replay-clip.mjs \
 *     --stack ~/.cache/emotiv-portal-replay/Emotiv-Dakkota \
 *     --video radio_connections-20261112-141626.mp4 \
 *     --station IP0040 --step IP0040-MAKE-RADIO-CONNECTIONS-AND-WITNESS \
 *     --out eval-lab/public/assets/emotiv/traces/radio_connections.json
 *
 * The stack is an export of comer-rokid-demo at a branch tip, started here as
 * a child process on its own port. Nothing in that repository is edited. The
 * frames go in the way the glasses send them: the whole view once a second to
 * `/vision/frame`, and the aim crop with its taller seat crop to
 * `/vision/connector`, 1.2 s after each answer. It runs at the clip's own
 * speed, because the stack's holds and its action window are wall clock.
 *
 * The trace is the answers, each stamped with the clip time the frame was
 * taken and the clip time the answer came back. The stack's own capture rows
 * are joined on, because the boxes and the per-opening reads are in those and
 * not in what the glasses are sent.
 *
 * The capture is written to a folder under the stack export. No bucket is
 * configured there, so nothing leaves this machine except the model calls.
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { trackFitting } from "./fit-track.mjs";

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const expand = (p) => (p && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const STACK = resolve(expand(arg("--stack", "~/.cache/emotiv-portal-replay/Emotiv-Dakkota")));
const VIDEO = resolve(expand(arg("--video", "")));
const STATION = arg("--station", "");
const STEP = arg("--step", "");
const OUT = resolve(expand(arg("--out", "")));
const PORT = Number(arg("--port", 3055));
const SINK_PORT = Number(arg("--sink-port", 3056));
const BRANCH = arg("--branch", basename(STACK));
/** The glasses' own cadence: `UPLINK_INTERVAL_MS` and `CONNECTOR_POLL_MS`. */
const UPLINK_MS = 1000;
const POLL_MS = 1200;
/** `MainActivity.SCENE_POLL_MS`. */
const SCENE_MS = 15_000;
/** `HarnessCamera.CROP_FRACTION` and `SEAT_CROP_TALLER`. */
const CROP_FRACTION = 0.2;
const SEAT_TALLER = 2;
/** `HarnessCamera.SCENE_MAX_EDGE`. */
const SCENE_EDGE = 1280;
const FPS = 5;

if (!VIDEO || !existsSync(VIDEO) || !STATION || !STEP || !OUT) {
  console.error("usage: replay-clip.mjs --video <mp4> --station <id> --step <id> --out <json> [--stack <dir>]");
  process.exit(2);
}
if (!existsSync(join(STACK, "backend", "server.js"))) {
  console.error(`no stack export at ${STACK}`);
  process.exit(2);
}

/** The procedure this step belongs to, from the stack's own station fixtures. */
function readProcedure() {
  const file = join(STACK, "tools", "dakkota-fms-mock", "fixtures", `${STATION.toLowerCase()}-procedure.json`);
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, "utf8"));
  const steps = Object.entries(j.steps || {}).map(([code, v]) => ({
    code, seq: v.jes_seq ?? null, label: v.label || code,
  }));
  const at = j.steps?.[STEP] || null;
  return {
    stationId: j.station_id || STATION,
    stationName: j.station_name || null,
    stepCode: STEP,
    stepIndex: at?.jes_seq ?? null,
    totalSteps: steps.length || null,
    stepLabel: at?.label || null,
    stepDescription: at?.description || null,
    steps,
  };
}
const procedure = readProcedure();

const BASE = `http://127.0.0.1:${PORT}/v1/emotiv`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envValue(name) {
  const text = readFileSync(join(STACK, "backend", ".env"), "utf8");
  const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

// ── frames ─────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "emotiv-replay-"));
const durationS = Number(execFileSync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", VIDEO,
]).toString().trim());
console.log(`clip ${basename(VIDEO)} · ${durationS.toFixed(1)} s · cutting frames`);
const scale = `scale='if(gt(iw,ih),${SCENE_EDGE},-2)':'if(gt(iw,ih),-2,${SCENE_EDGE})'`;
const side = `min(iw,ih)*${CROP_FRACTION}`;
execFileSync("ffmpeg", [
  "-v", "error", "-y", "-i", VIDEO,
  "-filter_complex",
  `[0:v]fps=${FPS},${scale},split=3[s][a0][t0];`
    + `[a0]crop=w='${side}':h='${side}'[a];`
    + `[t0]crop=w='${side}':h='${side}*${SEAT_TALLER}'[t]`,
  "-map", "[s]", "-q:v", "4", join(work, "scene-%05d.jpg"),
  "-map", "[a]", "-q:v", "3", join(work, "aim-%05d.jpg"),
  "-map", "[t]", "-q:v", "3", join(work, "seat-%05d.jpg"),
], { stdio: ["ignore", "ignore", "inherit"] });
const frameCount = readdirSync(work).filter((f) => f.startsWith("scene-")).length;
const frameAt = (t) => Math.min(frameCount, Math.max(1, Math.floor(t * FPS) + 1));
const b64 = (kind, t) => readFileSync(
  join(work, `${kind}-${String(frameAt(t)).padStart(5, "0")}.jpg`),
).toString("base64");
const sceneSize = execFileSync("ffprobe", [
  "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
  join(work, "scene-00001.jpg"),
]).toString().trim().split(",").map(Number);

// ── the stack, as a child ──────────────────────────────────────────────────
const captureDir = join(STACK, "capture", `${basename(OUT, ".json")}-${Date.now()}`);
mkdirSync(captureDir, { recursive: true });
for (const port of [PORT, SINK_PORT]) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).toString().trim();
    if (pids) {
      console.error(`port ${port} is taken (pid ${pids.split("\n").join(", ")})`);
      process.exit(1);
    }
  } catch { /* nothing listening */ }
}

/** What the stack would have told the line feed, and when. */
const advances = [];
let clock = () => null;
const sink = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* keep the raw text */ }
    advances.push({ t: clock(), path: req.url, body: parsed ?? body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => sink.listen(SINK_PORT, "127.0.0.1", r));

const logPath = join(captureDir, "server.log");
const child = spawn("node", ["server.js"], {
  cwd: join(STACK, "backend"),
  env: {
    ...process.env,
    // Uploads to Roboflow's inference hosts crawl over IPv6 on some networks.
    NODE_OPTIONS: "--dns-result-order=ipv4first",
    APP_PROFILE: "emotiv",
    BACKEND_PORT: String(PORT),
    EMOTIV_VISION_CAPTURE: "1",
    EMOTIV_VISION_CAPTURE_DIR: captureDir,
    EMOTIV_SESSION_VIDEO: "0",
    SESSION_CAPTURE: "0",
    EMOTIV_SESSION_CAPTURE_S3_BUCKET: "",
    SESSION_CAPTURE_S3_BUCKET: "",
    EMOTIV_STEP_ADVANCE_URL: `http://127.0.0.1:${SINK_PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (c) => { log += c; });
child.stderr.on("data", (c) => { log += c; });
const stop = () => {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  sink.close();
  try { writeFileSync(logPath, log); } catch { /* best effort */ }
};
const tidy = () => rmSync(work, { recursive: true, force: true });
process.on("SIGINT", () => { stop(); tidy(); process.exit(130); });

const keyPath = join(STACK, "backend", ".api-key");
let apiKey = "";
async function call(path, body, timeoutMs = 60_000) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

let health = null;
for (let i = 0; i < 60 && !health; i += 1) {
  await sleep(500);
  try {
    if (!apiKey && existsSync(keyPath)) apiKey = readFileSync(keyPath, "utf8").trim();
    const h = await call("/vision/health");
    if (h?.models) health = h;
  } catch { /* still starting */ }
}
if (!health) {
  stop();
  tidy();
  console.error("the stack did not come up; see", logPath);
  process.exit(1);
}
console.log(`seat reads: crop ${health.seatState?.enabled ? "on" : "OFF"} · row ${health.rowSeat?.enabled ? "on" : "OFF"}`
  + ` · module ${health.moduleSeat?.enabled ? "on" : "OFF"}`);
if (health.capture?.s3?.enabled) {
  stop();
  tidy();
  console.error("a bucket is configured on this stack export; refusing to replay into it");
  process.exit(1);
}

// ── warm the hosted models, so the first poll is not a cold start ──────────
// Straight to the endpoints with a grey square, the way `modelWarm.js` does
// it, so no module's count window or seat memory sees a made-up frame.
const rfKey = envValue("EMOTIV_ROBOFLOW_API_KEY") || envValue("ROBOFLOW_API_KEY");
const grey = execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=128x128", "-frames:v", "1",
  "-f", "image2", "-c:v", "mjpeg", "pipe:1",
]).toString("base64");
const hosted = [];
for (const [slot, m] of Object.entries(health.models || {})) {
  const id = m?.value;
  if (!id || /^(gemini|claude)/.test(id)) continue;
  const host = /^(fill|row)/.test(slot) ? "detect" : "classify";
  hosted.push({ slot, id, host });
}
const namesId = "dakkota-seat-ends-v7/13";
if (JSON.stringify(health).includes(namesId)) hosted.push({ slot: "seatRadioNames", id: namesId, host: "classify" });
// The action model reads a clip, so its container is warmed with one: four
// seconds of grey. A cold call there runs past the end of a one-minute clip.
const greyClip = execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=4", "-t", "4",
  "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
]).toString("base64");
if (health.cosmos?.enabled && health.cosmos?.model) {
  hosted.push({ slot: "action", id: health.cosmos.model, host: "serverless", clip: true });
}
console.log(`warming ${hosted.length} hosted models`);
const warmOnce = (list) => Promise.all(list.map(async ({ clip, ...m }) => {
  const started = Date.now();
  try {
    const res = await fetch(
      `https://${m.host}.roboflow.com/${m.id}?api_key=${encodeURIComponent(rfKey)}${clip ? "" : "&confidence=0"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: clip ? greyClip : grey,
        signal: AbortSignal.timeout(clip ? 90_000 : 45_000),
      },
    );
    await res.arrayBuffer();
    return { ...m, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ...m, ok: false, status: String(err?.name || "error"), ms: Date.now() - started };
  }
}));
// Twice. One warm call can land on a container that is not the one the next
// call reaches, and a cold first read costs the opening seconds of a clip.
const warmFirst = await warmOnce(hosted);
const warm = (await warmOnce(hosted)).map((w, i) => ({ ...w, firstMs: warmFirst[i].ms }));
for (const w of warm) console.log(`  ${w.ok ? "ok  " : "FAIL"} ${w.slot.padEnd(15)} ${w.id} · ${w.ms} ms`);

// ── the run ────────────────────────────────────────────────────────────────
const polls = [];
const uplinks = [];
const startedAt = Date.now();
const startedWall = new Date(startedAt).toISOString();
clock = () => Number(((Date.now() - startedAt) / 1000).toFixed(3));

function lean(answer) {
  if (!answer || typeof answer !== "object") return answer;
  const { scope, considered, candidates, ...rest } = answer;
  return {
    ...rest,
    candidates: (candidates || []).slice(0, 3).map((c) => ({
      className: c.className,
      confidence: c.confidence,
      rawConfidence: c.rawConfidence,
      describe: c.describe,
    })),
  };
}

const uplinkLoop = (async () => {
  while (clock() < durationS) {
    const t = clock();
    call("/vision/frame", { station: STATION, image_base64: b64("scene", t) }, 8000)
      .then((r) => uplinks.push({ t, back: clock(), ok: r?.ok === true }))
      .catch(() => uplinks.push({ t, back: clock(), ok: false }));
    await sleep(UPLINK_MS);
  }
})();

// The scene read behind the ambient line: `SCENE_POLL_MS`, no frame in the
// body, so the stack reads the whole view the uplink last delivered. The
// glasses are already running when a recording starts, so the phase here is
// arbitrary: the first one goes two seconds in.
const scenes = [];
const sceneLoop = (async () => {
  await sleep(2000);
  while (clock() < durationS) {
    const tSent = clock();
    call("/vlm/observe", {
      station: STATION,
      step: STEP,
      ...(procedure?.stepIndex ? { step_index: procedure.stepIndex } : {}),
      ...(procedure?.totalSteps ? { total_steps: procedure.totalSteps } : {}),
    }, 30_000)
      .then((r) => scenes.push({
        tSent, tBack: clock(), ok: r?.ok === true, reason: r?.reason ?? null,
        hud: r?.hud ?? null, summary: r?.observation?.summary ?? null, model: r?.model ?? r?.modelId ?? null,
      }))
      .catch((err) => scenes.push({ tSent, tBack: clock(), ok: false, reason: String(err?.name || err) }));
    await sleep(SCENE_MS);
  }
})();

// The first whole view has to be held before the first poll reads it.
await sleep(150);
while (clock() < durationS) {
  const tSent = clock();
  const wallSent = Date.now();
  let answer = null;
  let error = null;
  try {
    answer = await call("/vision/connector", {
      station: STATION,
      step: STEP,
      frame: b64("aim", tSent),
      seatFrame: b64("seat", tSent),
    });
  } catch (err) {
    error = String(err?.message || err);
  }
  const tBack = clock();
  polls.push({
    i: polls.length,
    tSent,
    tBack,
    wallSent,
    wallBack: Date.now(),
    ms: Math.round((tBack - tSent) * 1000),
    error,
    answer: lean(answer),
  });
  const fill = answer?.module?.fill;
  const count = fill?.decidable ? `${fill.fitted}/${fill.total}` : (fill?.held != null ? `(${fill.held})` : "-");
  process.stdout.write(
    `\r${tSent.toFixed(1).padStart(5)} s · poll ${String(polls.length).padStart(3)} · count ${count.padEnd(5)}`
    + ` · ${(answer?.ambient?.line || answer?.action?.className || "").slice(0, 34).padEnd(34)}`,
  );
  await sleep(POLL_MS);
}
await uplinkLoop;
await sceneLoop;
process.stdout.write("\n");
// Let the capture rows, a scene read and any advance in flight land.
await sleep(4000);
scenes.sort((a, b) => a.tSent - b.tSent);
const healthAfter = await call("/vision/health").catch(() => null);
await call("/vision/frame/clear", { station: STATION }).catch(() => null);
stop();

// ── the stack's own rows, joined on ────────────────────────────────────────
const rows = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "events.jsonl") {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* skip a torn line */ }
      }
    }
  }
}(captureDir));
rows.sort((a, b) => Date.parse(a.wall) - Date.parse(b.wall));
let joined = 0;
for (const row of rows) {
  const at = Date.parse(row.wall);
  const poll = polls.find((p) => !p.capture && at >= p.wallSent - 50 && at <= p.wallBack + 400);
  if (!poll) continue;
  const { wall, runId, source, still, lane, reviewed, ts, ...kept } = row;
  poll.capture = kept;
  joined += 1;
}
for (const p of polls) { delete p.wallSent; delete p.wallBack; }
// The whole view each poll read: the last one the stack had accepted when the
// poll went out, as a time in the clip. Frames are cut at a fixed rate, so
// this is the time of the picture, not of the upload.
const heldAt = (tSent) => uplinks.filter((u) => u.ok && u.back <= tSent + 0.02).sort((a, b) => b.t - a.t)[0] || null;
for (const p of polls) {
  const held = heldAt(p.tSent);
  p.frameT = held ? Number(((frameAt(held.t) - 1) / FPS).toFixed(3)) : null;
}

// ── which connector, by part number ────────────────────────────────────────
// The stack registers the radio face to part numbers for its fitting line
// (`radioFitting.js`) and sends the glasses only the sentence. This registers
// each read with that same module, from the stack export, over the boxes in
// the capture row and the whole view that poll read. `fit-track.mjs` then
// follows them through the stack's tracker and ties them to the server's lines.
const partNumbered = (ops) => ops.every((o) => /^WH-/.test(String(o.id)));
const decoderFace = (ops) => ({
  state: Object.fromEntries(ops.map((o) => [o.id, o.cls === "filled" ? "filled" : "empty"])),
  boxes: Object.fromEntries(ops.map((o) => [o.id, {
    x: o.box[0], y: o.box[1], width: o.box[2], height: o.box[3],
  }])),
});
let naming = null;
const fitPath = join(STACK, "backend", "lib", "emotiv", "radioFitting.js");
const radioStep = polls.some((p) => p.answer?.module?.zoneId === "EZ4");
if (radioStep && existsSync(fitPath)) {
  try {
    const fit = await import(fitPath);
    const { blueShare } = await import(join(STACK, "backend", "lib", "emotiv", "blueLandmark.js"));
    const sharp = createRequire(join(STACK, "backend", "package.json"))("sharp");
    for (const p of polls) {
      const ops = p.capture?.openings;
      // Eleven unnumbered boxes is a face the fitting line can register. A
      // row the count's decoder numbered itself is picked up further down.
      if (!Array.isArray(ops) || ops.length !== 11 || partNumbered(ops)) continue;
      const held = heldAt(p.tSent);
      if (!held) continue;
      const { data, info } = await sharp(Buffer.from(b64("scene", held.t), "base64"), { failOn: "none" })
        .removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
      const sx = info.width / (p.capture.imageW || info.width);
      const sy = info.height / (p.capture.imageH || info.height);
      const claimed = ops.map((o) => ({
        class: o.cls, confidence: o.conf, x: o.box[0], y: o.box[1], width: o.box[2], height: o.box[3],
      }));
      const face = fit.registerRadioFace(claimed, (b) => blueShare(data, info.width, info.height, {
        x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy,
      }));
      if (!face) continue;
      p.named = {
        by: "fitting",
        state: face.state,
        boxes: Object.fromEntries(Object.entries(face.boxes).map(([id, b]) => [
          id, [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
        ])),
      };
    }
    naming = await trackFitting({
      polls,
      stack: STACK,
      server: (healthAfter?.radioFit?.steps || []).slice(-1)[0] || null,
    });
    console.log(`named reads ${naming.replay.namedReads} · in ${naming.replay.in} · announced ${naming.replay.announced}`
      + ` · server ${JSON.stringify(naming.server)}`);
  } catch (err) {
    naming = { error: String(err?.message || err) };
    console.log(`naming pass failed: ${naming.error}`);
  }
}
tidy();

// The count's own decoder numbers a face once enough is fitted, and always on
// the gateway. Those rows are taken as numbered.
for (const p of polls) {
  const ops = p.capture?.openings;
  if (p.named || !Array.isArray(ops) || !ops.length || !partNumbered(ops)) continue;
  const face = decoderFace(ops);
  p.named = {
    by: "decoder",
    state: face.state,
    boxes: Object.fromEntries(Object.entries(face.boxes).map(([id, b]) => [id, [b.x, b.y, b.width, b.height]])),
  };
}
// What the seat read made of each numbered opening, beside its fill.
for (const p of polls) {
  if (!p.named) continue;
  const seat = Object.fromEntries((p.capture?.openings || [])
    .filter((o) => o.seat && o.id in p.named.state).map((o) => [o.id, o.seat]));
  if (Object.keys(seat).length) p.named.seat = seat;
}

// The panel's short name for each connector this step fits, from the stack's
// own word list, reduced the way the glasses reduce it (`hudConnector`).
let connectorNames = null;
try {
  const words = await import(join(STACK, "backend", "lib", "emotiv", "connectorWords.js"));
  const ids = polls.find((p) => p.answer?.module?.connectorIds)?.answer.module.connectorIds || [];
  connectorNames = Object.fromEntries(ids.map((id) => {
    const phrase = String(words.plainConnector(id)?.phrase || "").trim();
    if (!phrase || phrase.includes(id)) return [id, ""];
    let raw = phrase;
    if (phrase.includes(",")) raw = phrase.slice(phrase.lastIndexOf(",") + 1).trim();
    else if (phrase.includes(" connector ")) raw = phrase.slice(phrase.indexOf(" connector ") + 11).trim();
    for (const lead of ["the ", "with the ", "with "]) if (raw.startsWith(lead)) raw = raw.slice(lead.length);
    return [id, raw.trim()];
  }));
} catch { /* a stack without the word list names nothing */ }

const commit = existsSync(join(STACK, "COMMIT")) ? readFileSync(join(STACK, "COMMIT"), "utf8").trim() : null;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({
  clip: basename(VIDEO),
  generatedAt: startedWall,
  source: { repo: "AldoOmnia/comer-rokid-demo", branch: BRANCH, commit, profile: health.profile ?? "emotiv" },
  station: STATION,
  step: STEP,
  procedure,
  durationS: Number(durationS.toFixed(3)),
  frame: { width: sceneSize[0], height: sceneSize[1], cropFraction: CROP_FRACTION, seatTaller: SEAT_TALLER },
  cadence: { uplinkMs: UPLINK_MS, pollMs: POLL_MS, sceneMs: SCENE_MS },
  models: health.models,
  routing: health.vision?.purposes ?? null,
  actionClip: healthAfter?.actionClip ?? health.actionClip ?? null,
  cosmos: healthAfter?.cosmos ?? health.cosmos ?? null,
  radioFit: healthAfter?.radioFit ?? null,
  // Whether the seat reads were switched on for this pass. They default off in
  // the stack's code and on in the glasses backend's environment, so a trace
  // says which it was.
  seatReads: {
    crop: health.seatState?.enabled ?? null,
    row: health.rowSeat?.enabled ?? null,
    module: health.moduleSeat?.enabled ?? null,
  },
  naming,
  connectorNames,
  lastRefusal: healthAfter?.fill?.lastRefusal ?? null,
  warm,
  uplinks: {
    sent: uplinks.length,
    accepted: uplinks.filter((u) => u.ok).length,
    at: uplinks.filter((u) => u.ok).map((u) => u.back).sort((a, b) => a - b),
  },
  advances,
  scenes,
  polls,
}, null, 1)}\n`);
const read = polls.filter((p) => p.answer?.module?.fill?.decidable).length;
console.log(
  `${polls.length} polls · count read on ${read} · ${joined} capture rows joined · `
  + `${advances.length} advance post(s) → ${OUT}`,
);
console.log(`stack log and capture: ${captureDir}`);
