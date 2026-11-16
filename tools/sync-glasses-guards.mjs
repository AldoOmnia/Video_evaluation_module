#!/usr/bin/env node
/**
 * Copies what the Comer glasses warn about, and when, out of the glasses repo.
 *
 *   node tools/sync-glasses-guards.mjs <path to a comer-rokid-demo checkout> [git ref]
 *
 * Writes shared/data/glasses-guards-st100.json. Nothing in that file is typed
 * in here: the steps, their parts, their decoys and the step 7 pick order are
 * read from the procedure the glasses load, and every threshold is read from
 * the Kotlin source of the two guards. The digital twin's glasses preview is
 * built on this file, so re-run this when the glasses change and the preview
 * follows.
 *
 * Only `git show` is used on the glasses repo, so its working tree is never
 * touched and the ref does not have to be checked out.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [repo, ref = "origin/vision-eval"] = process.argv.slice(2);
if (!repo) {
  console.error("usage: node tools/sync-glasses-guards.mjs <path to comer-rokid-demo> [git ref]");
  process.exit(2);
}

const PATHS = {
  procedure: "backend/data/procedures/pinion-guide.json",
  wrongPart: "glasses-app/app/src/main/java/com/omnia/comer/memory/subscribers/WrongPartGuard.kt",
  sequence: "glasses-app/app/src/main/java/com/omnia/comer/memory/subscribers/SequenceGuard.kt",
  memory: "glasses-app/app/src/main/java/com/omnia/comer/memory/MemoryLayerConfig.kt",
  observe: "backend/routes/vlmObserve.js",
};

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64e6 });
const show = (path) => git("show", `${ref}:${path}`);
const lastCommit = (path) => git("log", "-1", "--format=%H %ad", "--date=short", ref, "--", path).trim();

/** `private const val NAME = 2_000L` → 2000. Fails loudly when a name is gone,
 *  so a rename on the glasses cannot quietly leave an old number in place. */
function constant(source, name, file) {
  const m = source.match(new RegExp(`const val ${name}\\s*=\\s*([0-9_.]+)`));
  if (!m) throw new Error(`${name} is not in ${file} at ${ref}`);
  return Number(m[1].replace(/_/g, ""));
}

/** `private val NAME = setOf("a", "b")` → ["a", "b"]. */
function skuSet(source, name, file) {
  const m = source.match(new RegExp(`val ${name}\\s*=\\s*setOf\\(([^)]*)\\)`));
  if (!m) throw new Error(`${name} is not in ${file} at ${ref}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const procedure = JSON.parse(show(PATHS.procedure));
const wrongPart = show(PATHS.wrongPart);
const sequence = show(PATHS.sequence);
const memory = show(PATHS.memory);
const observe = show(PATHS.observe);

const window30 = memory.match(/val recentObservationWindowMs: Long = ([0-9_]+)L/);
if (!window30) throw new Error(`recentObservationWindowMs is not in ${PATHS.memory} at ${ref}`);

const model = (name) => {
  const m = observe.match(new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*"([^"]+)"`));
  if (!m) throw new Error(`${name} has no default in ${PATHS.observe} at ${ref}`);
  return m[1];
};

// The time between two reads is not a setting on the glasses, it is whatever
// the round trip takes. The only number for it is the one measured on the line
// and written into the guard's comments, which is where its thresholds were
// tuned from — so that is the one taken, with the sentence it came from.
const cadence = wrongPart.replace(/\n\s*\*\s?/g, " ").match(/Measured on site over (\d+) consecutive live observe calls the cadence is now (\d+)ms median/);
if (!cadence) throw new Error(`the measured observe cadence is not in ${PATHS.wrongPart} at ${ref}`);

const steps = procedure.steps.map((s) => {
  const skus = (s.parts_referenced || []).filter(Boolean);
  // "BEARING, CONE, 82.5 X 36.0; DRIVER cod.3187.111.180.00" — one per part.
  const said = String(s.parts_description || "").split(";").map((x) => x.trim());
  return {
    n: s.step_number,
    title: s.title,
    detail: s.detail || "",
    lookFor: s.look_for || "",
    parts: skus.map((sku, i) => ({ sku, description: said.length === skus.length ? said[i] : "" })),
    decoys: (s.decoys || []).map((d) => ({
      sku: d.sku,
      decoyFor: d.decoy_for || null,
      headline: d.headline || "",
      action: d.action || "",
      description: d.description || "",
    })),
    pickSequence: (s.expected_pick_sequence || []).map((g) => ({ label: g.label || "", skus: g.skus || [] })),
  };
});

const out = {
  _source: {
    repo: "AldoOmnia/comer-rokid-demo",
    ref,
    commit: git("rev-parse", ref).trim(),
    files: Object.fromEntries(Object.entries(PATHS).map(([k, p]) => [k, { path: p, lastChanged: lastCommit(p) }])),
    copiedOn: new Date().toISOString().slice(0, 10),
    by: "tools/sync-glasses-guards.mjs",
  },
  procedure: { id: procedure.id, title: procedure.title },
  steps,
  wrongPartGuard: {
    builtInDecoys: skuSet(wrongPart, "DECOY_SKUS", PATHS.wrongPart),
    indistinguishable: skuSet(wrongPart, "INDISTINGUISHABLE_SKUS", PATHS.wrongPart),
    ...Object.fromEntries(
      [
        "WRONG_PART_CONSECUTIVE",
        "WRONG_PART_MIN_CONF",
        "INSTANT_DECOY_CONF",
        "INSTANT_DECOY_STRONG_CONF",
        "ORIENTATION_INSTANT_CONF",
        "ORIENTATION_OSCILLATION_MS",
        "HANDS_EMPTY_MIN_CONF",
        "WRONG_PART_ABSENCE_MS",
        "STICKY_DECOY_ABSENCE_MS",
        "CORRECT_CLEAR_STRONG_CONF",
        "CORRECT_CLEAR_CONSECUTIVE",
        "HEARTBEAT_MS",
        "MAX_DETAIL_CHARS",
      ].map((n) => [n, constant(wrongPart, n, PATHS.wrongPart)]),
    ),
  },
  sequenceGuard: Object.fromEntries(
    ["SEQ_MIN_CONF", "SEQ_CONSECUTIVE", "SEQ_ABSENCE_MS"].map((n) => [n, constant(sequence, n, PATHS.sequence)]),
  ),
  memory: { recentObservationWindowMs: Number(window30[1].replace(/_/g, "")) },
  observe: {
    model: model("GEMINI_VLM_OBSERVE_MODEL"),
    fallbackModel: model("GEMINI_VLM_FALLBACK_MODEL"),
    cadenceMs: Number(cadence[2]),
    // The median of this many consecutive live observe calls on the line.
    cadenceSamples: Number(cadence[1]),
  },
};

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "data", "glasses-guards-st100.json");
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
const guarded = steps.filter((s) => s.parts.length).length;
console.log(
  `${dest}\n  ${steps.length} steps, ${guarded} with parts, ` +
    `${steps.reduce((n, s) => n + s.decoys.length, 0)} step decoys, ` +
    `${steps.filter((s) => s.pickSequence.length).length} pick order — from ${ref} @ ${out._source.commit.slice(0, 8)}`,
);
