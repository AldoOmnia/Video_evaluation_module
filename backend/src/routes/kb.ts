/**
 * /api/kb — facility knowledge base backing the /knowledge/ view.
 *
 * The plant "Brain" is organised per station: every station on the line has
 * its own node graph of training material (documents, tables, video) and
 * component-recognition references (images mapped to error-taxonomy codes).
 *
 * Storage: a JSON store at eval-lab/public/.kb-store.json (dotfile — not
 * served by express.static) plus uploaded reference images written to
 * eval-lab/public/kb-uploads/ (served at /lab/kb-uploads/...). Good enough
 * for the pilot; swap for object storage + DB when multi-user editing lands.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { specs } from "../services/specs.js";
import { llmCall } from "../services/anthropic.js";
import { EVAL_LAB_PUBLIC, SHARED_DIR } from "../paths.js";
import { STATIONS, type StationId } from "../services/stations.js";

export const kbRouter = Router();

const STORE_PATH = join(EVAL_LAB_PUBLIC, ".kb-store.json");
const UPLOADS_DIR = join(EVAL_LAB_PUBLIC, "kb-uploads");
const UPLOADS_URL = "/lab/kb-uploads";
const MAX_FILE_BYTES = 8 * 1024 * 1024; // fits inside the 12mb JSON body cap

/* The station catalog is shared with the MES layer — see services/stations.ts. */


/* ── Station scoping for chat ─────────────────────────────────────────────
 * The deep knowledge base (procedure, components, tribal knowledge, POVs)
 * covers ONLY ST100 · Pinion Guide. When a question touches another station we
 * inject a guard so the LLM answers from that station's report data only — and
 * never dresses pinion-guide facts up as another station's knowledge.
 *
 * What the guard must NOT say any more: that other stations' data is unavailable
 * pending a connector. Direct read-only SQL to SSL04_FARGO is live, so every
 * station's current activity, phase history and measurements are queryable
 * through the line service (/api/line/ask). The gap is procedure-level
 * knowledge, not data access — and telling a director we cannot see their
 * station when we can is the worse error of the two. */
const STATION_QUERY_MATCHERS: ReadonlyArray<readonly [RegExp, StationId]> = [
  [/\bst\.?\s*-?\s*100\b|pinion\s+guide/i, "pg-04"],
  // "diff cover" is the shop-floor name for ST110, and the expansion plug is
  // the operation people name it by — neither says "ST110" or "brake & cover".
  [/\bst\.?\s*-?\s*110\b|brake\s*(?:&|and)\s*cover|diff(?:erential)?\s+cover|expan(?:sion|ding)\s+plug/i, "st110"],
  [/\bst\.?\s*-?\s*13[05]\b|shimming\s+(?:station|line|area|cell|bay)/i, "st130-135"],
  [/\bst\.?\s*-?\s*140\b|brake\s+complete/i, "st140"],
  [/\bst\.?\s*-?\s*150\b|pinion\s+complete/i, "st150"],
  [/\bst\.?\s*-?\s*160\b|axle\s+mount/i, "st160"],
  [/\bst\.?\s*-?\s*170\b|axle\s+mount/i, "st170"],
  [/\bst\.?\s*-?\s*1[89]0\b|test\s+bench|prova\s+di\s+tenuta|leak\s+test/i, "st180-190"],
  [/\bst\.?\s*-?\s*2[012]0\b|sub\s*differential/i, "st200-220"],
  [/\bst\.?\s*-?\s*300\b|tear\s*drop\s*box/i, "st300"],
  [/\bst\.?\s*-?\s*310\b/i, "st310"],
  [/\bst\.?\s*-?\s*4[01]0\b|wheel\s+axle/i, "st400-410"],
  [/\bst\.?\s*-?\s*5[012]0\b|starship/i, "st500-520"],
  [/\bst\.?\s*-?\s*7[01]0\b|sub\s+planetary/i, "st710"],
];

/** Line-wide error/quality questions get an anchoring table so every claim
 *  lands on the right station instead of everything collapsing onto ST100. */
const LINE_WIDE_QUESTION =
  /\b(?:most\s+)?(?:common|frequent|typical|biggest|worst|top|main)\b[^.?!]*\b(?:error|mistake|problem|defect|failure|issue)|error\s*rates?\b|checks?\s+(?:not\s+ok|outside|failing)|\bworst\s+station|\bwhich\s+station|\b(?:across|on)\s+the\s+(?:line|plant|facility)\b/i;

function mesLeaderboard(): string {
  const rows = STATIONS.filter((s) => s.report)
    .map((s) => ({ label: s.label, nok: s.report!.nok, checks: s.report!.checks }))
    .sort((a, b) => b.nok - a.nok)
    .map((r) => `${r.label}: ${r.nok}/${r.checks} outside limits`);
  rows.push(
    "ST400-410 · Subassembly: no data (Quad Track report — ST400 mounts LW/SW axle models)",
  );
  return rows.join(" · ");
}

/**
 * The single most damaging station mix-up on this line, called out by name.
 *
 * "Shimming" means two different things at Comer: Step 7 of the ST100 pinion
 * guide (shim pack, the one the KB is trained on) and the separate ST130-135
 * shimming cell at Stage 8. A question naming ST130 retrieves ST100's shim-pack
 * facts on topical similarity alone, and observed behaviour is that a general
 * "do not mix stations up" instruction does NOT stop the transplant — the model
 * answered "operators guess the starting shim with no reliable baseline" for
 * ST130, which is an ST100 fact. Naming the confusion explicitly does stop it,
 * so this string is injected wherever shims are mentioned.
 */
const SHIM_DISAMBIGUATION =
  "CRITICAL — 'SHIMMING' IS TWO DIFFERENT THINGS AND THIS IS THE MOST COMMON " +
  "MIX-UP: every shim fact in the knowledge base (starting shim value, shim " +
  "stack, rolling-torque target, iteration/guessing problems) belongs to ST100's " +
  "SHIM PACK step — Step 7 of the pinion guide. It does NOT describe the " +
  "ST130-135 Shimming cell (Stage 8), which is a physically different station " +
  "doing diff-carrier bolts, carrier height, preload and brake shim checks, and " +
  "whose procedure is NOT trained here. If asked about ST130-135, you must NOT " +
  "reuse any ST100 shim fact — say the Stage 8 shimming procedure is not trained " +
  "and give its MES numbers instead.";

export function buildStationScopeGuard(text: string): string {
  const ids = new Set<StationId>();
  for (const [re, id] of STATION_QUERY_MATCHERS) if (re.test(text)) ids.add(id);
  const pinionOnly = ids.size === 1 && ids.has("pg-04");
  ids.delete("pg-04"); // the KB genuinely covers the pinion guide

  const blocks: string[] = [];

  // Generic "most common errors / worst station / error rates" questions:
  // anchor deep-KB insights to ST100 and give the real per-station MES
  // numbers so line-wide claims land on the right stations.
  if (LINE_WIDE_QUESTION.test(text) && !pinionOnly) {
    blocks.push(
      "[LINE-WIDE ANCHORING — the deep knowledge base (procedure, operator/tribal knowledge, " +
        "common-mistake history, POV recordings) covers ONLY ST100 · Pinion Guide; label every " +
        "insight from it as ST100. " + SHIM_DISAMBIGUATION +
        " For the rest of the line the only loaded data is each station's MES " +
        "acquisition snapshot (Full_stations_report), checks outside limits per station:\n" +
        mesLeaderboard() +
        "\nAnchor every claim to its correct station. Those are HISTORICAL snapshot counts. " +
        "LIVE data for every station on the line is available too — ask about current " +
        "activity, today's throughput or recent failures and it is answered from the MES " +
        "directly. What is missing for stations other than ST100 is trained PROCEDURE " +
        "knowledge (steps, components, what commonly goes wrong), not data access.]",
    );
  }

  if (ids.size > 0) {
    const lines = [...ids].map((id) => {
      const s = STATIONS.find((st) => st.id === id)!;
      const r = s.report;
      const data = r
        ? `the ONLY data loaded is its MES acquisition snapshot (Full_stations_report sheet ${r.sheet}): ` +
          `${r.phases} phases, ${r.checks} checks — ${r.ok} within limits, ${r.nok} outside limits ` +
          `(sample checks: ${r.sample})`
        : "NO MES data in this snapshot — the export covers a Quad Track build and this station " +
          "mounts LW/SW axle models (per Mohammed, Comer mechanical engineer)";
      return `- ${s.label} (${s.stage} — ${s.desc}): ${data}.`;
    });
    const shimTrap = /\bshim|\bshimming|\bspessor/i.test(text) || ids.has("st130-135");
    blocks.push(
      "[STATION DATA SCOPE — DO NOT MIX STATIONS UP. The deep knowledge base " +
        "(procedure steps, components, supervisor/tribal knowledge, common-mistake history, POV " +
        "recordings) covers ONLY ST100 · Pinion Guide. The question touches other stations:\n" +
        lines.join("\n") +
        "\nFor these stations answer from the snapshot numbers above, plus ONLY those context " +
        "entries whose own text names the station itself (e.g. 'ST110 is the diff cover " +
        "station'). Every other entry in the corpus — all operator/tribal knowledge, " +
        "common-mistake history, POV findings — describes ST100 even where it reads " +
        "generically as 'the station', 'this station' or 'operators', and must NEVER be " +
        "restated against a different station. That generic phrasing is the trap: an ST100 " +
        "fact about 'the two most error-prone tasks on the station' is about the PINION GUIDE. " +
        "NEVER attribute ST100 pinion-guide mistakes, components, bearing-cup or shim-pack " +
        "facts to them. " +
        "Be precise about what is and is not available: their PROCEDURE is not trained here " +
        "(no step-by-step, no component recognition, no common-mistake history), but their LIVE MES " +
        "data IS accessible — current activity, phase history, measurements, pass/fail — via a " +
        "question about the line. Do NOT say their data is unavailable or pending a connector. " +
        "ATTRIBUTION IS MANDATORY: name the station every claim belongs to, even in a " +
        "one-sentence answer. An unattributed statement about a station whose procedure is " +
        "not trained reads as trained knowledge and is the failure to avoid." +
        (shimTrap ? "\n" + SHIM_DISAMBIGUATION : "") +
        "]",
    );
  }

  return blocks.join("\n\n");
}

interface KbImage {
  id: string;
  name: string;
  url: string;
  addedAt: string;
}
interface KbComponent {
  id: string;
  name: string;
  note: string | null;
  errorCodes: string[];
  images: KbImage[];
  addedAt: string;
  /** "glasses" = mirrored from the live comer-rokid-demo build (read-only reference). */
  source?: "glasses" | "report";
  /** Procedure steps the part is used in (e.g. ["S06","S09"]) — from the glasses catalogue. */
  steps?: string[];
  /** The live warning the glasses fire when this part's failure mode is seen. */
  warning?: { headline: string; action: string } | null;
}
interface KbArtifact {
  id: string;
  name: string;
  type: "pdf" | "csv" | "video" | "other";
  size: number | null;
  note: string | null;
  url: string | null; // set when the file itself was small enough to store
  addedAt: string;
  /** "glasses" = comer-rokid-demo build · "report" = Full_stations_report.xlsx MES export */
  source?: "glasses" | "report";
}
interface KbPovSuggestion {
  step: string | null;
  errorCode: string | null;
  observed: string;
  detect: string;
  glassesWarning: string;
}
interface KbPovAnalysis {
  summary: string;
  suggestions: KbPovSuggestion[];
  audioUsed: boolean;
  stubbed: boolean;
  analyzedAt: string;
}
interface KbPov {
  id: string;
  name: string;
  size: number | null;
  durationS: number | null;
  label: "correct" | "mistake";
  note: string | null;
  transcript: string | null; // audio transcript — manual today, ASR later
  analysis: KbPovAnalysis | null;
  addedAt: string;
}
interface KbStore {
  stations: Record<
    string,
    { artifacts: KbArtifact[]; components: KbComponent[]; povs?: KbPov[] }
  >;
  /** Set once the glasses-build knowledge (comer-rokid-demo) is seeded into PG-04. */
  glassesSyncedAt?: string;
  /** Bumped when the seed content grows — lets existing stores pick up additions. */
  glassesSyncVersion?: number;
}

function loadStore(): KbStore {
  let store: KbStore = { stations: {} };
  try {
    if (existsSync(STORE_PATH)) {
      store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as KbStore;
    }
  } catch {
    /* corrupted store — start fresh rather than brick the endpoint */
  }
  if ((store.glassesSyncVersion ?? 0) < GLASSES_SYNC_VERSION && seedGlassesKnowledge(store)) {
    store.glassesSyncedAt = new Date().toISOString();
    store.glassesSyncVersion = GLASSES_SYNC_VERSION;
    saveStore(store);
  }
  return store;
}
function saveStore(store: KbStore) {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
function stationBucket(store: KbStore, id: string) {
  if (!store.stations[id]) store.stations[id] = { artifacts: [], components: [], povs: [] };
  const bucket = store.stations[id];
  if (!bucket.povs) bucket.povs = [];
  return bucket as { artifacts: KbArtifact[]; components: KbComponent[]; povs: KbPov[] };
}

function findStation(id: string) {
  return STATIONS.find((s) => s.id === id) ?? null;
}

/** Seeded glasses component (with structured steps + live warning) by SKU —
 *  used by /api/assist to enrich a Gemini vision identification. */
export function findGlassesComponent(sku: string): KbComponent | null {
  const store = loadStore();
  const bucket = store.stations["pg-04"];
  return bucket?.components.find((c) => c.id === `glasses-${sku}`) ?? null;
}

/* ── Glasses-build sync (comer-rokid-demo → PG-04) ────────────────────────
 *
 * The Rokid glasses build already recognizes the pinion-station parts and
 * fires live warnings (wrong orientation, wrong driver, wrong shim). Its
 * knowledge is vendored into this repo:
 *   shared/data/pinion-parts-catalogue.json   — per-SKU visual fingerprints
 *   shared/data/pinion-guide-steps-st100.csv  — the 17-step ST.100 procedure
 *   eval-lab/public/assets/pinion-components/ — CV reference images (768px)
 * On first store load we seed PG-04 with the same components + material so
 * the platform reflects exactly what is running on the glasses.
 */
const GLASSES_IMG_BASE = "/lab/assets/pinion-components";
/** Bump when GLASSES_COMPONENTS / GLASSES_ARTIFACTS / station reports grow so live stores re-merge. */
const GLASSES_SYNC_VERSION = 11;
const GLASSES_REPO = "https://github.com/AldoOmnia/comer-rokid-demo";

interface CataloguePart {
  part_number_comer: string;
  part_number_cnh: string;
  description: string;
  used_in_steps?: number[];
  notes?: string;
  _synthetic?: boolean;
  decoy_for?: string;
  warning?: { headline: string; action: string };
}

/**
 * Display name, taxonomy codes, and vendored reference images per glasses SKU.
 * Exported: /api/assist attaches the same references to its Gemini vision calls.
 *
 * `codes` mirror ONLY the warnings actually wired on the glasses build
 * (WrongPartGuard + SequenceGuard + spec decoys — verified against
 * comer-rokid-demo memory-architecture):
 *   - ORIENTATION  → the four -FLIP decoys (steps 1 / 2 / 4 / 6)
 *   - SUBSTITUTION → the C-ring WRONG PART demo trigger (step 7)
 *   - ORDER        → the step-7 shim-pack pick sequence (CHECK ORDER)
 * Everything else is recognition/ID-only today — codes stay empty so the
 * platform never claims a warning the glasses don't fire.
 * `warning` (when set) overrides/supplies the live overlay copy for wired
 * warnings that don't come from a catalogue decoy entry.
 */
export const GLASSES_COMPONENTS: Record<
  string,
  { name: string; codes: string[]; images: string[]; warning?: { headline: string; action: string } }
> = {
  // Step 1 — pressed onto cover (punch fixture 3187.111.100.09); FLIP decoy fires
  // WRONG ORIENTATION. TIMKEN stamped side UP (stamp 'TIMKEN NP241715' — the
  // earlier "big cup" position photos were actually the small cup; rewired in
  // glasses commit 757cb211 with the engineer's dedicated JPEGs, and a92ac902
  // added the thick-rim discriminator + Phase-1 work-instruction anchor).
  // The side-by-side 'bearing_cups_…timken_up' shot is the rim-width contrast ref.
  "248114A1": { name: "Bearing cup 248114A1 — inboard bevel pinion (big cup)", codes: ["ORIENTATION"], images: ["bearing_cup_248114a1_pos_correct_1.jpg", "bearing_cup_248114a1_flip_1.jpg", "bearing_cups_248114a1_191440a1_timken_up.jpg"] },
  // Step 2 — TIMKEN side DOWN (stamp 'TIMKEN 572 CD1 RM VN' — deliberately the
  // OPPOSITE convention of the big cup). Correct/flip set re-shot in 757cb211
  // (the misfiled big-cup photos were really this cup); side view is identity-only.
  "191440A1": { name: "Bearing cup 191440A1 — small cover cup", codes: ["ORIENTATION"], images: ["bearing_cup_191440a1_pos_correct_1.jpg", "bearing_cup_191440a1_flip_1.jpg", "bearing_cup_191440a1_side_1.jpg", "bearing_cups_248114a1_191440a1_timken_down.jpg"] },
  // Step 4 — pressed onto pinion shaft (punch 3187.111.100.07); FLIP decoy fires
  // WRONG ORIENTATION. Line-engineer verified 2026-07-14: TIMKEN side DOWN /
  // roller cage UP — the OPPOSITE convention of the step-6 cone.
  "248118A1": { name: "Bearing cone 248118A1 — inboard bevel pinion", codes: ["ORIENTATION"], images: ["bearing_cone_248118a1_pos_correct_1.jpg", "bearing_cone_248118a1_flip.jpg"] },
  // Step 6 — placed on cover (driver 3187.111.180.00 over it); FLIP decoy fires
  // WRONG ORIENTATION. Convention: TIMKEN stamped face UP (opposite of step 4).
  "67190R91": { name: "Bearing cone 67190R91 — upper pinion", codes: ["ORIENTATION"], images: ["bearing_cone_67190r91_pos_correct_1.jpg", "bearing_cone_67190r91_flip.jpg"] },
  // Step 7 shim pack — SequenceGuard slot 2 ("shims": .101/.130 counted as ONE
  // slot; the VLM can't tell them apart, so no substitution warning is wired).
  "191711A1": { name: "Shim .101 — bevel pinion bearing (191711A1)", codes: ["ORDER"], images: ["IMG_3081.jpg"],
    warning: { headline: "CHECK ORDER", action: "Pick order: thick spacer retainer (92203637) → shims → thin spacer retainer (191713A1)" } },
  "191712A1": { name: "Shim .130 — bevel pinion bearing (191712A1)", codes: ["ORDER"], images: ["IMG_3080.jpg"],
    warning: { headline: "CHECK ORDER", action: "Pick order: thick spacer retainer (92203637) → shims → thin spacer retainer (191713A1)" } },
  // Step 7 shim pack — SequenceGuard slot 3 (thin spacer retainer, last pick).
  "191713A1": { name: "Spacer / retainer shim ring (191713A1)", codes: ["ORDER"], images: ["IMG_3074.jpg"],
    warning: { headline: "CHECK ORDER", action: "Last pick of the shim pack — thick spacer retainer and shims go first" } },
  // Step 7 shim pack — SequenceGuard slot 1 (thick spacer retainer, first pick).
  "92203637": { name: "Ring retainer, thick 92203637", codes: ["ORDER"], images: ["part_n_92203637.jpg"],
    warning: { headline: "CHECK ORDER", action: "First pick of the shim pack — before shims and the thin spacer retainer" } },
  // Step 16 — recognition/ID only.
  "92203640": { name: "Ring, snap retainer 92203640", codes: [], images: ["part_n_92203640.jpg"] },
  // Step 7 decoy — the original WrongPartGuard demo trigger (visually distinct, open gap).
  "229515A2": { name: "External retaining ring 229515A2 (C-ring)", codes: ["SUBSTITUTION"], images: ["ring_retainer_229515A2.jpg"],
    warning: { headline: "WRONG PART", action: "Not for step 7 - put it back" } },
  // Recognition/ID only — no warnings wired on these today.
  "837-12030": { name: "Dowel pin 12.018 × 30 mm (837-12030)", codes: [], images: ["IMG_3077.jpg"] },
  "14441231": { name: "Screw hex-soc M6×12 (14441231)", codes: [], images: ["IMG_3076.jpg"] },
  "628-8016": { name: "Bolt M8×16 10.9 PHC (628-8016)", codes: [], images: ["IMG_3075.jpg"] },
  "3187.111.180.00": { name: "Press driver cod.3187.111.180.00 (Step 6 cone)", codes: [], images: ["driver_3187_111_180_00.jpg"] },
  "3187.111.100.27": { name: "Punch fixture cod.3187.111.100.27 (Step 8 retainer)", codes: [], images: ["driver_3187_111_100_27.jpg"] },
  "3187.111.100.28": { name: "Driver cod.3187.111.100.28 (Step 14 shim pack)", codes: [], images: ["driver_3187_111_100_28.jpg"] },
};

/**
 * Everything the glasses backend loads at boot, mapped one-to-one to PG-04.
 * `file` entries are vendored copies served at /shared-data; `repoPath`
 * entries are reference links into the glasses repo (source of truth) for
 * material too big to vendor (PDFs, images, audio).
 */
const GLASSES_ARTIFACTS: Array<
  Pick<KbArtifact, "name" | "type" | "note"> & { file?: string; repoPath?: string; id?: string }
> = [
  { name: "ST.100 pinion cover procedure — 17 steps", type: "csv", file: "pinion-guide-steps-st100.csv", note: "Step titles, VLM image refs, correct/wrong CV identities per step (glasses build)" },
  { name: "Comer ↔ CNH parts catalogue v2", type: "other", file: "pinion-parts-catalogue.json", note: "Per-SKU visual fingerprints the VLM uses to tell lookalike parts apart" },
  { name: "Comer product catalogue (primary LLM knowledge)", type: "other", file: "comer-catalogue.json", note: "Driveshaft / TCs spec catalogue — first knowledge block in every glasses /query prompt" },
  { name: "Torque table", type: "csv", file: "torque-table.csv", note: "Torque specs the warning logic checks values against" },
  { name: "Tolerance spec", type: "csv", file: "tolerances.csv", note: "Acceptance ranges per measurement step" },
  { name: "Shim SKU lookup", type: "csv", file: "shim-sku-lookup.csv", note: "Measured gap → correct shim SKU (S07 wrong-shim warning)" },
  { name: "Historical error rates", type: "csv", file: "error-rates.csv", note: "Defect rates per step — grounds the 'most common mistakes' answers" },
  // Stable id: this entry's display name changes as fact blocks land — without
  // it, every rename would re-seed as a new artifact (learned the hard way).
  { id: "glasses-art-supervisor-knowledge", name: "Operator tribal knowledge — 14 curated fact blocks", type: "other", repoPath: "backend/data/supervisor-knowledge", note: "Matteo + Mohammed audio-transcribed facts + line-engineer cup & cone orientation rules (2026-07-14) + station-vs-axle-model note (ST400 = LW/SW axle mount, report build = Quad Track, 2026-07-16) — AUTHORITATIVE shop-floor notes; mirrored in chat retrieval here" },
  { name: "KB errors doc — engineer-verified orientation rules", type: "other", file: "errors-pinion-guide-for-kb.txt", note: "errors_pinion_guide_for_KB.txt — the authoritative TIMKEN-side rules for all four orientation-sensitive parts + the fixture/driver confusion note" },
  { name: "Pinion phase sheets — Phase 1–12 PDFs", type: "pdf", repoPath: "docs/source-material/Comer_industries_pinion_steps", note: "Original Comer work instructions the ST.100 steps + VLM keyframes were extracted from" },
  { name: "Comer knowledge-base catalogues — 5 product PDFs", type: "pdf", repoPath: "Comer_industries_knowledge_base", note: "Rockford fan clutch, Walterscheid PTO, gearboxes, planetary drives, Synergy driveshafts" },
  { name: "Component reference photo set — 55 angles", type: "other", repoPath: "docs/source-material/pinion-components/images", note: "Full-resolution source of the 19 reference images below (768px copies attached per component)" },
];

function seedGlassesKnowledge(store: KbStore): boolean {
  let catalogue: CataloguePart[];
  try {
    const raw = JSON.parse(
      readFileSync(join(SHARED_DIR, "data", "pinion-parts-catalogue.json"), "utf8"),
    ) as { parts: CataloguePart[] };
    catalogue = raw.parts;
  } catch {
    return false; // catalogue not vendored — retry on next load
  }

  const now = new Date().toISOString();
  const bucket = stationBucket(store, "pg-04");

  // -FLIP decoy identities carry the live glasses warning for their real part.
  const decoyBySku = new Map(
    catalogue.filter((p) => p._synthetic && p.decoy_for).map((p) => [p.decoy_for as string, p]),
  );

  const components: KbComponent[] = [];
  for (const part of catalogue) {
    if (part._synthetic) continue;
    const sku = part.part_number_cnh || part.part_number_comer;
    const cfg = GLASSES_COMPONENTS[sku];
    if (!cfg) continue;
    const steps = (part.used_in_steps ?? []).map((n) => `S${String(n).padStart(2, "0")}`);
    const decoy = decoyBySku.get(sku);
    // Warning precedence: catalogue -FLIP decoy > guard-level copy (C-ring
    // WrongPartGuard, shim-pack SequenceGuard) > none (recognition-only).
    const warning = decoy?.warning ?? cfg.warning ?? null;
    const noteParts = [
      steps.length
        ? `ST.100 ${steps.join(" · ")}`
        : warning
          ? "decoy trigger — not itself part of the procedure"
          : "recognition-only (not in current procedure)",
      warning
        ? `glasses fire: ${warning.headline} — ${warning.action}`
        : "recognition/ID only — no warning wired on the glasses",
    ].filter(Boolean);
    components.push({
      id: `glasses-${sku}`,
      name: cfg.name,
      note: noteParts.join(" · "),
      steps,
      warning,
      errorCodes: validErrorCodes(cfg.codes),
      images: cfg.images.map((f) => ({
        id: `glasses-img-${f}`,
        name: f,
        // ?v= busts the 7-day immutable browser cache when a reference photo's
        // content changes under the same filename (e.g. the 757cb211 cup rewire).
        url: `${GLASSES_IMG_BASE}/${f}?v=${GLASSES_SYNC_VERSION}`,
        addedAt: now,
      })),
      addedAt: now,
      source: "glasses",
    });
  }
  // Procedure order first, recognition-only parts last.
  const firstStep = (c: KbComponent) => {
    const m = c.note?.match(/S(\d\d)/);
    return m ? Number(m[1]) : 99;
  };
  components.sort((a, b) => firstStep(a) - firstStep(b));

  const artifacts: KbArtifact[] = GLASSES_ARTIFACTS.map((a) => {
    let size: number | null = null;
    if (a.file) {
      try {
        size = readFileSync(join(SHARED_DIR, "data", a.file)).length;
      } catch { /* file missing — keep null */ }
    }
    return {
      id: a.id ?? `glasses-art-${a.file ?? a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: a.name,
      type: a.type,
      size,
      note: a.note,
      url: a.file
        ? `/shared-data/${a.file}`
        : a.repoPath
          ? `${GLASSES_REPO}/tree/main/${a.repoPath}`
          : null,
      addedAt: now,
      source: "glasses",
    };
  });

  // Merge: seeded entries (glasses-* / report-* ids) are refreshed in place so
  // a seed-version bump updates them; anything a manager added by hand is kept.
  const mergeById = <T extends { id: string }>(existing: T[], seeded: T[]): T[] => {
    const bySeedId = new Map(seeded.map((s) => [s.id, s]));
    const kept = existing.map((e) => bySeedId.get(e.id) ?? e);
    const present = new Set(kept.map((e) => e.id));
    return [...kept, ...seeded.filter((s) => !present.has(s.id))];
  };
  // Prune glasses-seeded entries that dropped out of the seed set (renamed /
  // removed on the glasses build) BEFORE merging, so stale mirrors disappear.
  const seededArtIds = new Set(artifacts.map((a) => a.id));
  const seededCompIds = new Set(components.map((c) => c.id));
  bucket.artifacts = bucket.artifacts.filter((a) => a.source !== "glasses" || seededArtIds.has(a.id));
  bucket.components = bucket.components.filter((c) => c.source !== "glasses" || seededCompIds.has(c.id));
  bucket.components = mergeById(bucket.components, components);
  bucket.artifacts = mergeById(bucket.artifacts, artifacts);

  // Every station gets its slice of the MES acquisition report
  // (Full_stations_report.xlsx, one sheet per station, vendored as CSV).
  for (const s of STATIONS) {
    const rep = s.report;
    if (!rep) continue;
    let size: number | null = null;
    try {
      size = readFileSync(join(SHARED_DIR, "data", "stations-report", `${rep.sheet}.csv`)).length;
    } catch { continue; /* report CSV not vendored — skip this station */ }
    const stBucket = stationBucket(store, s.id);
    stBucket.artifacts = mergeById(stBucket.artifacts, [{
      id: `report-art-${rep.sheet}`,
      name: `MES acquisition report — ${rep.sheet}`,
      type: "csv",
      size,
      note: `${rep.phases} phases · ${rep.checks} checks: ${rep.ok} OK / ${rep.nok} NOT OK — ${rep.sample}`,
      url: `/shared-data/stations-report/${rep.sheet}.csv`,
      addedAt: now,
      source: "report",
    }]);
  }
  return true;
}

/** Decode a base64 payload (optionally a data: URL) and write it to disk. */
function saveUpload(stationId: string, name: string, dataBase64: string): { url: string; bytes: number } {
  const b64 = dataBase64.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new Error("empty file");
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
  const fileName = `${stationId}-${Date.now()}-${safe}`;
  mkdirSync(UPLOADS_DIR, { recursive: true });
  writeFileSync(join(UPLOADS_DIR, fileName), buf);
  return { url: `${UPLOADS_URL}/${fileName}`, bytes: buf.length };
}

function stationSummary(store: KbStore, s: (typeof STATIONS)[number]) {
  const bucket = store.stations[s.id] ?? { artifacts: [], components: [], povs: [] };
  const keysteps = s.procedureId === "proc:pinion-guide" ? specs.procedure.keysteps.length : 0;
  return {
    ...s,
    counts: {
      keysteps,
      artifacts: bucket.artifacts.length,
      components: bucket.components.length,
      images: bucket.components.reduce((n, c) => n + c.images.length, 0),
      povs: (bucket.povs ?? []).length,
    },
  };
}

/* ── Reads ────────────────────────────────────────────────────────────── */

kbRouter.get("/stations", (_req, res) => {
  const store = loadStore();
  res.json({ stations: STATIONS.map((s) => stationSummary(store, s)) });
});

kbRouter.get("/stations/:id", (req, res) => {
  const station = findStation(req.params.id);
  if (!station) return res.status(404).json({ error: "unknown station" });
  const store = loadStore();
  const bucket = store.stations[station.id] ?? { artifacts: [], components: [], povs: [] };
  const hasGlasses =
    bucket.artifacts.some((a) => a.source === "glasses") ||
    bucket.components.some((c) => c.source === "glasses");
  res.json({
    station: stationSummary(store, station),
    artifacts: bucket.artifacts,
    components: bucket.components,
    povs: bucket.povs ?? [],
    keysteps:
      station.procedureId === "proc:pinion-guide"
        ? specs.procedure.keysteps.map((k) => ({ id: k.id, order: k.order, label: k.label, risk: k.risk }))
        : [],
    // One-way mirror of the live glasses build: glasses → platform only.
    // Platform uploads are NOT pushed back to the glasses (yet).
    glassesSync: hasGlasses
      ? { syncedAt: store.glassesSyncedAt ?? null, repo: GLASSES_REPO, direction: "one-way" }
      : null,
  });
});

/* ── Training material ────────────────────────────────────────────────── */

const ArtifactBody = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["pdf", "csv", "video", "other"]),
  size: z.number().int().nonnegative().optional(),
  note: z.string().max(500).optional(),
  dataBase64: z.string().optional(), // small pdf/csv files travel inline
});

kbRouter.post("/stations/:id/artifacts", (req, res) => {
  const station = findStation(req.params.id);
  if (!station) return res.status(404).json({ error: "unknown station" });
  const body = ArtifactBody.parse(req.body);

  let url: string | null = null;
  if (body.dataBase64 && body.type !== "video") {
    try {
      url = saveUpload(station.id, body.name, body.dataBase64).url;
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }

  const store = loadStore();
  const artifact: KbArtifact = {
    id: randomUUID(),
    name: body.name,
    type: body.type,
    size: body.size ?? null,
    note: body.note ?? null,
    url,
    addedAt: new Date().toISOString(),
  };
  stationBucket(store, station.id).artifacts.unshift(artifact);
  saveStore(store);
  res.json({ ok: true, artifact });
});

kbRouter.delete("/stations/:id/artifacts/:aid", (req, res) => {
  const store = loadStore();
  const bucket = stationBucket(store, req.params.id);
  const target = bucket.artifacts.find((a) => a.id === req.params.aid);
  if (!target) return res.status(404).json({ error: "not found" });
  if (target.source === "glasses") {
    return res.status(409).json({ error: "loaded on the glasses build — manage it in comer-rokid-demo" });
  }
  bucket.artifacts = bucket.artifacts.filter((a) => a.id !== req.params.aid);
  saveStore(store);
  res.json({ ok: true });
});

/* ── Component recognition references ─────────────────────────────────── */

const ImageBody = z.object({
  name: z.string().min(1).max(200),
  dataBase64: z.string().min(8),
});
const ComponentBody = z.object({
  name: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  errorCodes: z.array(z.string().max(40)).max(20).default([]),
  images: z.array(ImageBody).max(10).default([]),
});

function validErrorCodes(codes: string[]): string[] {
  const known = new Set(Object.keys((specs.taxonomy as { errors: Record<string, unknown> }).errors));
  return codes.filter((c) => known.has(c));
}

kbRouter.post("/stations/:id/components", (req, res) => {
  const station = findStation(req.params.id);
  if (!station) return res.status(404).json({ error: "unknown station" });
  const body = ComponentBody.parse(req.body);

  const images: KbImage[] = [];
  try {
    for (const img of body.images) {
      const saved = saveUpload(station.id, img.name, img.dataBase64);
      images.push({ id: randomUUID(), name: img.name, url: saved.url, addedAt: new Date().toISOString() });
    }
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }

  const store = loadStore();
  const component: KbComponent = {
    id: randomUUID(),
    name: body.name,
    note: body.note ?? null,
    errorCodes: validErrorCodes(body.errorCodes),
    images,
    addedAt: new Date().toISOString(),
  };
  stationBucket(store, station.id).components.unshift(component);
  saveStore(store);
  res.json({ ok: true, component });
});

kbRouter.post("/stations/:id/components/:cid/images", (req, res) => {
  const station = findStation(req.params.id);
  if (!station) return res.status(404).json({ error: "unknown station" });
  const body = z.object({ images: z.array(ImageBody).min(1).max(10) }).parse(req.body);

  const store = loadStore();
  const component = stationBucket(store, station.id).components.find((c) => c.id === req.params.cid);
  if (!component) return res.status(404).json({ error: "component not found" });

  try {
    for (const img of body.images) {
      const saved = saveUpload(station.id, img.name, img.dataBase64);
      component.images.push({ id: randomUUID(), name: img.name, url: saved.url, addedAt: new Date().toISOString() });
    }
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
  saveStore(store);
  res.json({ ok: true, component });
});

/* ── Procedure POV recordings ─────────────────────────────────────────── */

const PovBody = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().nonnegative().optional(),
  durationS: z.number().nonnegative().optional(),
  label: z.enum(["correct", "mistake"]),
  note: z.string().max(1000).optional(),
  // Audio transcript of the recording. Entered manually today; when an ASR
  // service is wired (POV_ASR_URL / NIM Riva), the backend fills this from
  // the video's audio track automatically.
  transcript: z.string().max(8000).optional(),
});

kbRouter.post("/stations/:id/povs", (req, res) => {
  const station = findStation(req.params.id);
  if (!station) return res.status(404).json({ error: "unknown station" });
  const body = PovBody.parse(req.body);

  const store = loadStore();
  const pov: KbPov = {
    id: randomUUID(),
    name: body.name,
    size: body.size ?? null,
    durationS: body.durationS ?? null,
    label: body.label,
    note: body.note ?? null,
    transcript: body.transcript?.trim() || null,
    analysis: null,
    addedAt: new Date().toISOString(),
  };
  stationBucket(store, station.id).povs.unshift(pov);
  saveStore(store);
  res.json({ ok: true, pov });
});

kbRouter.delete("/stations/:id/povs/:pid", (req, res) => {
  const store = loadStore();
  const bucket = stationBucket(store, req.params.id);
  const before = bucket.povs.length;
  bucket.povs = bucket.povs.filter((p) => p.id !== req.params.pid);
  if (bucket.povs.length === before) return res.status(404).json({ error: "not found" });
  saveStore(store);
  res.json({ ok: true });
});

/**
 * Analyze a POV recording against the station's known material.
 *
 * Compares what the recording shows (audio transcript + operator note) with
 * the procedure keysteps and the error taxonomy, and suggests what went
 * wrong plus what the glasses' warning logic must detect to catch it live.
 */
kbRouter.post("/stations/:id/povs/:pid/analyze", async (req, res, next) => {
  try {
    const station = findStation(req.params.id);
    if (!station) return res.status(404).json({ error: "unknown station" });
    const store = loadStore();
    const pov = stationBucket(store, station.id).povs.find((p) => p.id === req.params.pid);
    if (!pov) return res.status(404).json({ error: "pov not found" });

    // Allow the caller to (re)supply the transcript at analyze time.
    const extra = z.object({ transcript: z.string().max(8000).optional() }).parse(req.body ?? {});
    if (extra.transcript?.trim()) pov.transcript = extra.transcript.trim();

    const hasProcedure = station.procedureId === "proc:pinion-guide";
    const keystepsTxt = hasProcedure
      ? specs.procedure.keysteps
          .map((k) => `S${String(k.order).padStart(2, "0")} ${k.label} — ${k.description ?? ""} acceptance: ${k.acceptance ?? "n/a"}`)
          .join("\n")
      : "(no formal procedure spec loaded for this station yet — reason from the station description and general assembly practice)";
    const tax = specs.taxonomy as {
      errors: Record<string, { group: string; label: string; desc: string }>;
    };
    const taxonomyTxt = Object.entries(tax.errors)
      .map(([code, e]) => `${code} (${e.group}) ${e.label}: ${e.desc}`)
      .join("\n");

    const bucket = stationBucket(store, station.id);
    const componentsTxt = bucket.components.length
      ? bucket.components.map((c) => `${c.name} → mapped errors: ${c.errorCodes.join(", ") || "none"}`).join("\n")
      : "(none mapped yet)";

    const system =
      "You are the manufacturing-quality Brain for a Comer Industries assembly line. " +
      "You review POV (point-of-view) recordings of procedures from smart glasses and " +
      "propose warning-logic entries. Answer ONLY with raw JSON — no markdown fences, " +
      "no prose before or after — matching: " +
      '{"summary": string, "suggestions": [{"step": string|null, "errorCode": string|null, ' +
      '"observed": string, "detect": string, "glassesWarning": string}]}. ' +
      "summary: max 2 sentences. observed/detect: max 1 sentence each. " +
      "errorCode MUST be one of the taxonomy codes or null. step is like S07 or null. " +
      "detect = the concrete signal the CV/audio/MES warning logic must watch for. " +
      "glassesWarning = short imperative line shown on the glasses (max 8 words). " +
      "For a 'correct' recording, suggestions list what SHOULD be checked to confirm each risky moment (still fill errorCode with the risk it guards). Max 5 suggestions.";

    const user = [
      `Station: ${station.label} — ${station.desc}`,
      ``,
      `Procedure keysteps:`,
      keystepsTxt,
      ``,
      `Error taxonomy:`,
      taxonomyTxt,
      ``,
      `Components already mapped at this station:`,
      componentsTxt,
      ``,
      `POV recording: "${pov.name}" — operator tagged this execution as: ${pov.label.toUpperCase()}`,
      pov.durationS ? `Duration: ${Math.round(pov.durationS)}s` : "",
      pov.note ? `Operator note: ${pov.note}` : "",
      ``,
      `Audio transcript from the recording:`,
      pov.transcript || "(no audio transcript available — reason from the note and tag only)",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await llmCall({ route: "kb-pov", system, user, maxTokens: 1600 });

    let parsed: { summary?: string; suggestions?: KbPovSuggestion[] } = {};
    try {
      const clean = result.text.replace(/```(?:json)?/g, "").trim();
      const jsonTxt = clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1);
      parsed = JSON.parse(jsonTxt);
    } catch {
      parsed = { summary: result.text.replace(/```(?:json)?/g, "").trim().slice(0, 500), suggestions: [] };
    }
    const known = new Set(Object.keys(tax.errors));
    const suggestions = (parsed.suggestions ?? []).slice(0, 5).map((s) => ({
      step: typeof s.step === "string" ? s.step : null,
      errorCode: s.errorCode && known.has(s.errorCode) ? s.errorCode : null,
      observed: String(s.observed ?? ""),
      detect: String(s.detect ?? ""),
      glassesWarning: String(s.glassesWarning ?? ""),
    }));

    pov.analysis = {
      summary: String(parsed.summary ?? ""),
      suggestions,
      audioUsed: Boolean(pov.transcript),
      stubbed: result.stubbed,
      analyzedAt: new Date().toISOString(),
    };
    saveStore(store);
    res.json({ ok: true, pov, latencyMs: result.latencyMs });
  } catch (e) {
    next(e);
  }
});

kbRouter.delete("/stations/:id/components/:cid", (req, res) => {
  const store = loadStore();
  const bucket = stationBucket(store, req.params.id);
  const target = bucket.components.find((c) => c.id === req.params.cid);
  if (!target) return res.status(404).json({ error: "not found" });
  if (target.source === "glasses") {
    return res.status(409).json({ error: "loaded on the glasses build — manage it in comer-rokid-demo" });
  }
  bucket.components = bucket.components.filter((c) => c.id !== req.params.cid);
  saveStore(store);
  res.json({ ok: true });
});
