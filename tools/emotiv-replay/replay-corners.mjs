#!/usr/bin/env node
/**
 * Replay the caliper, bolt and rosebud recordings through the glasses readers.
 *
 *   node tools/emotiv-replay/replay-corners.mjs [--only id,id] [--ambient] [--hold]
 *
 * `--ambient` reads the bolt traces already on disk and fills the glasses
 * one-liner from the pick action model. It does not call the bolt detector.
 *
 * `--hold` reads the bolt traces already on disk and holds the card from the
 * reader's first raise to the end of the take. It calls no model.
 *
 * Calipers and bolts call the same detectors the glasses poll. Rosebuds are
 * decoded here (tag36h11) and then read by the same placement functions the
 * `/v1/harness/observe` route calls. Nothing in the glasses repository is
 * written. The trace is what that route would have put on the panel.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const STACK = "/Users/aldopetruzzelli/.cursor/worktrees/comer-rokid-demo/calipers-voice";
const ENV_FILE = "/Users/aldopetruzzelli/.cursor/worktrees/comer-rokid-demo/gvh/backend/.env";
const PY = "/tmp/rosebud-tags/bin/python3";
const COMMIT = "84afcae";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
const ONLY = new Set(arg("--only").split(",").map((s) => s.trim()).filter(Boolean));

function loadRoboflowKey() {
  const text = readFileSync(ENV_FILE, "utf8");
  const m = text.match(/^\s*ROBOFLOW_API_KEY\s*=\s*(.*)$/m);
  const key = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  if (!key) throw new Error("ROBOFLOW_API_KEY is not set");
  process.env.ROBOFLOW_API_KEY = key;
  process.env.APP_PROFILE = "emotiv";
}

const CLIPS = join(ROOT, "eval-lab/public/assets/emotiv/clips");
const TRACES = join(ROOT, "eval-lab/public/assets/emotiv/traces");
const MEDIA = "/Users/aldopetruzzelli/.cursor/worktrees/comer-rokid-demo/gvh/ml/datasets";
const CORNERS = join(MEDIA, "Calipers_Bolts");
const HARNESS = join(MEDIA, "dakkota-harness/recordings");
const FIXTURES = {
  OP0080: join(STACK, "tools/corners-fms-mock/fixtures/op0080-procedure.json"),
  OP0085: join(STACK, "tools/corners-fms-mock/fixtures/op0085-procedure.json"),
  IP0030: join(STACK, "tools/dakkota-fms-mock/fixtures/ip0030-procedure.json"),
};

const JOBS = [
  {
    id: "lh_picking_wrong_caliper-20261112-152652",
    video: join(CLIPS, "lh_picking_wrong_caliper-20261112-152652.mp4"),
    lane: "caliper", side: "LH", zoneId: "CAL-LH",
    station: "OP0080", step: "OP0080-INSTALL-LH-CALIPER", fps: 1,
  },
  {
    id: "rh_picking_wrong_caliper_02-20261112-152622",
    video: join(CLIPS, "rh_picking_wrong_caliper_02-20261112-152622.mp4"),
    lane: "caliper", side: "RH", zoneId: "CAL-RH",
    station: "OP0080", step: "OP0080-REPEAT-RH-SIDE", fps: 1,
  },
  {
    id: "bolt_case_01_wrong_pick-20261112-124904",
    video: join(CORNERS, "bolt-pick/bolt_case_01_wrong_pick-20261112-124904.mp4"),
    lane: "bolt", caseId: "01", zoneId: "BOLT-01",
    station: "OP0085", step: "OP0085-HAND-START-FASTENERS", fps: 1,
  },
  {
    id: "bolt_case_02_wrong_pick-20261112-125131",
    video: join(CORNERS, "bolt-pick/bolt_case_02_wrong_pick-20261112-125131.mp4"),
    lane: "bolt", caseId: "02", zoneId: "BOLT-02",
    station: "OP0085", step: "OP0085-HAND-START-CASE-RH", fps: 1,
  },
  {
    id: "bolt_case_03_wrong_pick-20261112-125233",
    video: join(CORNERS, "bolt-pick/bolt_case_03_wrong_pick-20261112-125233.mp4"),
    lane: "bolt", caseId: "03", zoneId: "BOLT-03",
    station: "OP0085", step: "OP0085-HAND-START-CASE-BLUE", fps: 1,
  },
  {
    id: "driver_side_a_pillar_2_wrong_rosebud-20261112-163937",
    video: join(CLIPS, "driver_side_a_pillar_2_wrong_rosebud-20261112-163937.mp4"),
    lane: "rosebud", station: "IP0030", step: "IP0030-ROSEBUDS-24", jesStep: 3, fps: 2,
  },
  {
    id: "passenger_side_a_pillar_6_not_clipped-20261112-163854",
    video: join(CLIPS, "passenger_side_a_pillar_6_not_clipped-20261112-163854.mp4"),
    lane: "rosebud", station: "IP0030", step: "IP0030-ROSEBUDS-24", jesStep: 3, fps: 2,
  },
  {
    id: "missed_passenger_side_a_pillar_rosebuds-20261112-163758",
    video: join(HARNESS, "20261111-rosebud-position/missed/passenger-a-pillar/missed_passenger_side_a_pillar_rosebuds-20261112-163758.mp4"),
    lane: "rosebud", station: "IP0030", step: "IP0030-ROSEBUDS-24", jesStep: 3, fps: 2,
  },
  {
    id: "passenger_side_a_pillar_easy_602_0304_missed_rosebud-20261106-121032",
    video: join(HARNESS, "20261105-rosebud-position/missed/passenger-a-pillar/missed/passenger_side_a_pillar_easy_602_0304_missed_rosebud-20261106-121032.mp4"),
    lane: "rosebud", station: "IP0030", step: "IP0030-ROSEBUDS-24", jesStep: 3, fps: 2,
  },
];

function procedureFor(station, step) {
  const j = JSON.parse(readFileSync(FIXTURES[station], "utf8"));
  const steps = Object.entries(j.steps || {}).map(([code, v]) => ({
    code, seq: v.jes_seq ?? null, label: v.label || code,
  }));
  const at = j.steps?.[step] || null;
  return {
    stationId: j.station_id || station,
    stationName: j.station_name || null,
    stepCode: step,
    stepIndex: at?.jes_seq ?? null,
    totalSteps: steps.filter((s) => s.seq != null).length || steps.length,
    stepLabel: at?.label || null,
    stepDescription: at?.description || at?.label || null,
    steps,
  };
}

function cutFrames(video, fps) {
  const dir = mkdtempSync(join(tmpdir(), "emotiv-corners-"));
  const durationS = Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video,
  ]).toString().trim());
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", video,
    "-vf", `fps=${fps},scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'`,
    "-q:v", "4", join(dir, "f-%05d.jpg"),
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const files = readdirSync(dir).filter((f) => f.startsWith("f-")).sort();
  return { dir, durationS, files };
}

function cardWarning(list) {
  return (list || []).find((w) => w && (w.severity === "warn" || w.severity === "advise")) || null;
}

function slimWarning(w) {
  if (!w) return null;
  return {
    id: w.id,
    family: w.family,
    severity: w.severity,
    summary: w.summary,
    hud: w.hud,
    vars: w.vars || {},
  };
}

loadRoboflowKey();
const {
  readCaliper, noteCaliperRead, caliperTurnedWarning, _resetCaliperForTests, caliperModel,
} = await import(join(STACK, "backend/lib/emotiv/caliperParts.js"));
const {
  readBolt, noteBoltRead, boltWrongWarning, _resetBoltForTests, boltModel,
} = await import(join(STACK, "backend/lib/emotiv/boltPick.js"));
const { observeTags } = await import(join(STACK, "backend/lib/harnessPlacement.js"));
const {
  placementWarnings, holdRosebudWarning, _resetRosebudLatchForTests,
} = await import(join(STACK, "backend/lib/emotiv/warnings.js"));
const { withholdOnLooseRuler } = await import(join(STACK, "backend/lib/emotiv/rosebudPlace.js"));
const { rosebudsReadOut, noteRosebudCases } = await import(join(STACK, "backend/lib/emotiv/fillAdvance.js"));
const { readZonePitch } = await import(join(STACK, "backend/lib/emotiv/rosebudPitch.js"));
const {
  armBoltStage, noteBoltStageFrame, boltAmbient, describeBoltStage,
  _boltStageInFlightForTests, _resetBoltStageForTests,
} = await import(join(STACK, "backend/lib/emotiv/boltStage.js"));

const cal = caliperModel("CAL-LH");
const heads = boltModel("BOLT-01");
const stand = boltModel("BOLT-02");
if (!cal?.id || !heads?.id || !stand?.id) {
  console.error("a corners model is not routed");
  process.exit(1);
}
console.log(`caliper ${cal.id}`);
console.log(`bolt heads ${heads.id}`);
console.log(`bolt standoff ${stand.id}`);

async function replayDetector(job, read, note, warningFor, reset) {
  reset();
  const { dir, durationS, files } = cutFrames(job.video, job.fps);
  const polls = [];
  const key = `${job.station}|${job.step}`;
  try {
    for (let i = 0; i < files.length; i++) {
      const t = i / job.fps;
      const b64 = readFileSync(join(dir, files[i])).toString("base64");
      const started = Date.now();
      const result = await read(b64, {
        zoneId: job.zoneId,
        caseId: job.caseId,
        station: job.station,
        step: job.step,
      });
      const up = note(key, result);
      const warning = up ? slimWarning(warningFor()) : null;
      const readOut = job.lane === "caliper"
        ? {
          side: job.side,
          verdict: result.ok ? result.verdict : null,
          why: result.ok ? result.why : (result.reason || null),
          score: result.ok ? result.score : null,
          confirmed: up,
        }
        : {
          caseId: job.caseId,
          verdict: result.ok ? result.verdict : null,
          why: result.ok ? result.why : (result.reason || null),
          className: result.ok ? result.className : null,
          confidence: result.ok ? result.confidence : null,
          hand: result.ok ? (result.hand?.role ?? null) : null,
          confirmed: up,
        };
      polls.push({
        i,
        tSent: t,
        tBack: t,
        ms: Date.now() - started,
        answer: {
          ok: true,
          modelId: result.modelId || "",
          candidates: [],
          hud: { label: "", detail: "" },
          warning,
          warnings: warning ? [warning] : [],
          [job.lane]: readOut,
        },
      });
      const mark = warning ? " CARD" : "";
      console.log(`  ${t.toFixed(1)}s ${readOut.verdict || readOut.why || result.reason || "—"}${mark}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { durationS, polls, modelId: job.lane === "caliper" ? cal.id : (job.caseId === "02" ? stand.id : heads.id) };
}

async function replayRosebud(job) {
  _resetRosebudLatchForTests();
  const { dir, durationS, files } = cutFrames(job.video, job.fps);
  let decoded;
  try {
    const raw = execFileSync(PY, [join(ROOT, "tools/emotiv-replay/decode-rosebud-frames.py"), dir], {
      maxBuffer: 64 * 1024 * 1024,
    });
    decoded = JSON.parse(raw.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const polls = [];
  const latchKey = `IP-030|3`;
  // Same window the glasses use (TagConfirmer): a tag has to recur in 3 of the
  // last 8 frames before it can take the focus, so a one-frame misread cannot
  // name the zone.
  const seen = [];
  for (let i = 0; i < decoded.length; i++) {
    const t = i / job.fps;
    const now = Math.round(t * 1000);
    const tags = decoded[i].tags || {};
    const frameIds = Object.keys(tags).map(Number);
    seen.push(frameIds);
    if (seen.length > 8) seen.shift();
    const tally = new Map();
    for (const frame of seen) for (const id of frame) tally.set(id, (tally.get(id) || 0) + 1);
    const counts = {};
    for (const [id, n] of tally) if (n >= 3) counts[id] = n;
    const tagIds = Object.keys(counts).map(Number).sort((a, b) => a - b);
    const geometry = {};
    for (const id of tagIds) if (tags[id]) geometry[id] = tags[id];
    const observation = observeTags({
      tagIds,
      counts,
      geometry,
      stationId: job.station,
      stepCode: job.step,
      step: job.jesStep,
    });
    observation.places = withholdOnLooseRuler(
      observation.places,
      rosebudsReadOut(observation.scope?.station, observation.scope?.jesStep),
    );
    const listed = holdRosebudWarning(latchKey, placementWarnings(observation), now);
    const warning = slimWarning(cardWarning(listed));
    noteRosebudCases({
      station: observation.scope?.station,
      step: observation.scope?.jesStep,
      places: observation.places,
      zones: observation.clipping?.step?.zones,
      pitches: { AZ6: readZonePitch(observation.inStep || [], "AZ6") },
      warning: Boolean(warning && warning.id === "placement/rosebud-not-clipped"),
      now,
    });
    polls.push({
      i,
      tSent: t,
      tBack: t,
      ms: 0,
      answer: {
        ok: true,
        modelId: "tag36h11",
        candidates: [],
        hud: { label: "", detail: "" },
        warning,
        warnings: warning ? [warning] : [],
        rosebud: {
          tags: tagIds,
          detail: warning?.hud?.detail || null,
          id: warning?.id || null,
        },
      },
    });
    console.log(`  ${t.toFixed(1)}s tags ${tagIds.join(",") || "none"}${warning ? ` CARD ${warning.hud.detail}` : ""}`);
  }
  return { durationS, polls, modelId: "tag36h11" };
}

const roles = {
  caliper: "Whether the caliper is turned round",
  bolt: "Whether the bolt in the hand is the wrong one",
  rosebud: "Whether a rosebud is clipped in",
};

// The pick action model, from boltStage.js. It names choosing, picking or
// inserting. It does not name the bolt and it may not warn.
const BOLT_STAGE = {
  key: "boltStage",
  slot: "boltStage",
  id: "dakkota-bolt-pick-v1/7",
  role: "Which stage the bolt pass is in",
  metric: "choosing · picking · inserting",
  status: "ambient line only · may not warn or gate",
};

function routedFor(job, modelId) {
  if (job.lane === "caliper") {
    return [{
      key: "caliper", slot: "caliperParts", id: modelId, role: roles.caliper,
      zone: job.zoneId, floor: 0.4, classes: 3, status: "routed",
    }];
  }
  if (job.lane === "bolt") {
    const heads = job.caseId !== "02";
    return [{
      key: "bolt",
      slot: heads ? "boltHeads" : "boltStandoff",
      id: modelId,
      role: roles.bolt,
      zone: job.zoneId,
      floor: 0.4,
      classes: heads ? 4 : 2,
      status: "routed",
    }, { ...BOLT_STAGE, zone: job.zoneId }];
  }
  return [{
    key: "rosebud", slot: "rosebudTags", id: modelId, role: roles.rosebud,
    zone: "IP-030", metric: "AprilTag", status: "routed",
  }];
}

// Pillar 6 is clipped in at 21.5s. The tags are under the hands, so the
// passenger latch keeps the line. The time is set by hand from the recording.
const HAND_CLEAR = {
  "passenger_side_a_pillar_6_not_clipped-20261112-163854": {
    t: 21.5,
    setBy: "hand",
    reason: "The rosebud is clipped in. The tags are covered, so the reader holds the line.",
  },
};

// Pillars 2, 3 and 4 rest on the beam in the station take, so the pitch stays
// above the floor and the reader never raises. The card is the glasses' own
// line, held until the hand has pushed them in. Both times are from the picture.
const HAND_SHOW = {
  "missed_passenger_side_a_pillar_rosebuds-20261112-163758": {
    t: 32,
    setBy: "hand",
    detail: "Clip passenger pillars 2, 3 and 4 in",
    reason: "The rosebuds rest on the beam, so the pitch stays above the floor. The card stays up until they are clipped in.",
  },
};

const HAND_WARNING = {
  id: "placement/rosebud-not-clipped",
  family: "placement",
  severity: "advise",
  summary: "One of two named rosebuds is not clipped in",
  hud: { label: "Rosebud not clipped in", detail: "" },
  vars: { zoneId: "AZ6", lo: 2, hi: 4, panel: "" },
};

function cutClipFrames(video) {
  const dir = mkdtempSync(join(tmpdir(), "emotiv-boltclip-"));
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", video,
    "-vf", "fps=8,scale='if(gt(iw,ih),640,-2)':'if(gt(iw,ih),-2,640)'",
    "-q:v", "4", join(dir, "f-%05d.jpg"),
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const files = readdirSync(dir).filter((f) => f.startsWith("f-")).sort();
  return { dir, files };
}

// The glasses' fast lane: eight frames a second, long edge 640, and the
// pick action model names choosing, picking or inserting. The line is what
// boltAmbient writes onto a bolt poll.
async function stampBoltAmbient(job, polls) {
  _resetBoltStageForTests();
  const { dir, files } = cutClipFrames(job.video);
  const pass = `${job.station}|bolt-${job.caseId}`;
  const events = [
    ...files.map((file, i) => ({ kind: "frame", t: i / 8, file })),
    ...polls.map((poll, i) => ({ kind: "poll", t: poll.tSent, i })),
  ].sort((a, b) => a.t - b.t || (a.kind === "frame" ? -1 : 1));
  let lined = 0;
  try {
    for (const ev of events) {
      const now = Math.round(ev.t * 1000);
      if (ev.kind === "frame") {
        armBoltStage(job.station, pass, now);
        const b64 = readFileSync(join(dir, ev.file)).toString("base64");
        noteBoltStageFrame(job.station, b64, { lane: "clip", now });
        const flight = _boltStageInFlightForTests(job.station);
        if (flight) await flight;
        continue;
      }
      const poll = polls[ev.i];
      const verdict = poll.answer.bolt?.verdict;
      const amb = boltAmbient(job.station, {
        verdict: verdict === "correct" || verdict === "wrong" ? verdict : null,
      }, now);
      poll.answer.ambient = amb.line
        ? {
          line: amb.line,
          source: "boltStage",
          stage: amb.stage,
          verdict: amb.verdict,
          ageMs: amb.ageMs,
        }
        : null;
      if (amb.line) lined += 1;
      console.log(`  ${ev.t.toFixed(1)}s ${amb.line || "—"}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const health = describeBoltStage();
  console.log(`stage calls ${health.calls} failed ${health.failures} · line on ${lined}/${polls.length}`);
  if (health.lastFailure) console.log(`last stage failure: ${health.lastFailure.reason}`);
}

function applyHandShow(job, polls) {
  const show = HAND_SHOW[job.id];
  if (!show) return null;
  const warning = {
    ...HAND_WARNING,
    hud: { ...HAND_WARNING.hud, detail: show.detail },
    vars: { ...HAND_WARNING.vars, panel: show.detail },
  };
  for (const p of polls) {
    const rose = p.answer.rosebud || (p.answer.rosebud = {});
    rose.setBy = "hand";
    if (p.tSent + 1e-6 < show.t) {
      p.answer.warning = warning;
      p.answer.warnings = [warning];
      rose.detail = show.detail;
      rose.id = warning.id;
      delete rose.home;
    } else {
      p.answer.warning = null;
      p.answer.warnings = [];
      rose.detail = null;
      rose.id = null;
      rose.home = true;
    }
  }
  return show;
}

// In each bolt take the wrong bolt is picked and started, and the correct one
// is never picked. The reader raises the card and then loses the bolt once it
// is in the hole. From its first raise the card stays up to the end of the
// take. The hold is set by hand from the recording.
const HAND_HOLD = {
  "bolt_case_01_wrong_pick-20261112-124904": true,
  "bolt_case_02_wrong_pick-20261112-125131": true,
  "bolt_case_03_wrong_pick-20261112-125233": true,
};

function applyHandHold(job, polls) {
  if (!HAND_HOLD[job.id]) return null;
  const first = polls.find((p) => p.answer.bolt?.confirmed && p.answer.warning);
  if (!first) return null;
  let card = first.answer.warning;
  let held = 0;
  for (const p of polls) {
    if (p.tSent < first.tSent) continue;
    const bolt = p.answer.bolt || (p.answer.bolt = {});
    if (bolt.confirmed && p.answer.warning) {
      card = p.answer.warning;
      delete bolt.held;
      continue;
    }
    p.answer.warning = card;
    p.answer.warnings = [card];
    bolt.held = "hand";
    held += 1;
  }
  return {
    t: first.tSent,
    setBy: "hand",
    reads: held,
    reason: "The correct bolt is never picked in this take, so the card stays up to the end.",
  };
}

function boltNote(polls, held) {
  const read = polls.filter((p) => p.answer.bolt?.confirmed).length;
  if (!held) {
    return read ? `The card is up on ${read} of ${polls.length} reads.` : `None of the ${polls.length} reads raised the card.`;
  }
  return `The reader raises the card on ${read} of ${polls.length} reads. From ${held.t}s it is held to the end, set by hand from the recording: the correct bolt is never picked.`;
}

function applyHandClear(job, polls) {
  const clear = HAND_CLEAR[job.id];
  if (!clear) return null;
  for (const p of polls) {
    if (p.tSent + 1e-6 < clear.t) continue;
    p.answer.warning = null;
    p.answer.warnings = [];
    if (p.answer.rosebud) {
      p.answer.rosebud.detail = null;
      p.answer.rosebud.id = null;
      p.answer.rosebud.home = true;
    }
  }
  return clear;
}

if (process.argv.includes("--hold")) {
  for (const job of JOBS) {
    if (job.lane !== "bolt") continue;
    if (ONLY.size && !ONLY.has(job.id)) continue;
    const out = join(TRACES, `${job.id}.json`);
    const trace = JSON.parse(readFileSync(out, "utf8"));
    trace.held = applyHandHold(job, trace.polls);
    trace.note = boltNote(trace.polls, trace.held);
    writeFileSync(out, JSON.stringify(trace));
    console.log(`${job.id}\n  ${trace.note}`);
  }
  process.exit(0);
}

if (process.argv.includes("--ambient")) {
  for (const job of JOBS) {
    if (job.lane !== "bolt") continue;
    if (ONLY.size && !ONLY.has(job.id)) continue;
    const out = join(TRACES, `${job.id}.json`);
    const trace = JSON.parse(readFileSync(out, "utf8"));
    console.log(`\n${job.id}`);
    await stampBoltAmbient(job, trace.polls);
    writeFileSync(out, JSON.stringify(trace));
    console.log(`wrote ${out}`);
  }
  process.exit(0);
}

for (const job of JOBS) {
  if (ONLY.size && !ONLY.has(job.id)) continue;
  console.log(`\n${job.id}`);
  const ran = job.lane === "rosebud"
    ? await replayRosebud(job)
    : await replayDetector(
      job,
      job.lane === "caliper" ? readCaliper : readBolt,
      job.lane === "caliper" ? noteCaliperRead : noteBoltRead,
      () => (job.lane === "caliper" ? caliperTurnedWarning(job.side) : boltWrongWarning(job.caseId)),
      job.lane === "caliper" ? _resetCaliperForTests : _resetBoltForTests,
    );
  const shown = applyHandShow(job, ran.polls);
  const cleared = shown
    ? { t: shown.t, setBy: "hand", reason: "Pillars 2, 3 and 4 are clipped in." }
    : applyHandClear(job, ran.polls);
  const held = job.lane === "bolt" ? applyHandHold(job, ran.polls) : null;
  const raised = ran.polls.filter((p) => p.answer.warning).length;
  const trace = {
    clip: `${job.id}.mp4`,
    generatedAt: new Date().toISOString(),
    lane: job.lane,
    source: { repo: "AldoOmnia/comer-rokid-demo", branch: "emotiv-dakkota-calipers/bolts", commit: COMMIT },
    station: job.station,
    step: job.step,
    procedure: procedureFor(job.station, job.step),
    durationS: ran.durationS,
    cadence: { pollMs: 1000 / job.fps, uplinkMs: 1000 },
    advances: [],
    reader: { role: roles[job.lane], modelId: ran.modelId },
    routed: routedFor(job, ran.modelId),
    note: shown
      ? `The card is up on ${raised} of ${ran.polls.length} reads, set by hand from the recording. It drops at ${shown.t}s, once they are clipped in.`
      : held
        ? boltNote(ran.polls, held)
        : raised
          ? `The card is up on ${raised} of ${ran.polls.length} reads.`
          : `None of the ${ran.polls.length} reads raised the card.`,
    raised: shown ? { setBy: "hand", detail: shown.detail, reason: shown.reason } : null,
    cleared,
    held,
    polls: ran.polls,
  };
  if (job.lane === "bolt") await stampBoltAmbient(job, trace.polls);
  const out = join(TRACES, `${job.id}.json`);
  writeFileSync(out, JSON.stringify(trace));
  console.log(`wrote ${out} · card on ${raised}/${ran.polls.length}`);
}
