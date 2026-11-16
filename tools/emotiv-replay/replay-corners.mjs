#!/usr/bin/env node
/**
 * Replay the caliper, bolt and rosebud recordings through the glasses readers.
 *
 *   node tools/emotiv-replay/replay-corners.mjs [--only id,id]
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
  const cleared = applyHandClear(job, ran.polls);
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
    note: raised
      ? `The card is up on ${raised} of ${ran.polls.length} reads.`
      : `None of the ${ran.polls.length} reads raised the card.`,
    cleared,
    polls: ran.polls,
  };
  const out = join(TRACES, `${job.id}.json`);
  writeFileSync(out, JSON.stringify(trace));
  console.log(`wrote ${out} · card on ${raised}/${ran.polls.length}`);
}
