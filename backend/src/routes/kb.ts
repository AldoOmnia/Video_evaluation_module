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

export const kbRouter = Router();

const STORE_PATH = join(EVAL_LAB_PUBLIC, ".kb-store.json");
const UPLOADS_DIR = join(EVAL_LAB_PUBLIC, "kb-uploads");
const UPLOADS_URL = "/lab/kb-uploads";
const MAX_FILE_BYTES = 8 * 1024 * 1024; // fits inside the 12mb JSON body cap

/** The line as captured in the synthetic-pov tour + the PG-04 pilot station. */
const STATIONS = [
  {
    id: "pg-04",
    label: "Pinion Guide · PG-04",
    desc: "Pilot station — full procedure graph + eval tools live",
    tier: "core",
    active: true,
    procedureId: "proc:pinion-guide",
  },
  { id: "st-1", label: "Station 1", desc: "Vertical press fixture machine", tier: "core", active: false, procedureId: null },
  { id: "st-2", label: "Station 2", desc: "Assembly station", tier: "core", active: false, procedureId: null },
  { id: "st-3", label: "Station 3", desc: "UNICOMM system", tier: "core", active: false, procedureId: null },
  { id: "st-4", label: "Station 4", desc: "Component picking area", tier: "core", active: false, procedureId: null },
  { id: "pm-5", label: "Perimeter 5", desc: "Drivers selection", tier: "outer", active: false, procedureId: null },
  { id: "pm-6", label: "Perimeter 6", desc: "Pinion guide station end", tier: "outer", active: false, procedureId: null },
  { id: "pm-7", label: "Perimeter 7", desc: "Pinion guide station end", tier: "outer", active: false, procedureId: null },
] as const;

type StationId = (typeof STATIONS)[number]["id"];

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
  source?: "glasses";
}
interface KbArtifact {
  id: string;
  name: string;
  type: "pdf" | "csv" | "video" | "other";
  size: number | null;
  note: string | null;
  url: string | null; // set when the file itself was small enough to store
  addedAt: string;
  source?: "glasses";
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
/** Bump when GLASSES_COMPONENTS / GLASSES_ARTIFACTS grow so live stores re-merge. */
const GLASSES_SYNC_VERSION = 2;
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

/** Display name, taxonomy codes, and vendored reference images per glasses SKU. */
const GLASSES_COMPONENTS: Record<
  string,
  { name: string; codes: string[]; images: string[] }
> = {
  "248114A1": { name: "Bearing cup 248114A1 — inboard bevel pinion (big cup)", codes: ["ORIENTATION"], images: ["bearing_cup_248114a1_pos_correct_1.jpg", "bearing_cup_248114a1_flip_1.jpg"] },
  "191440A1": { name: "Bearing cup 191440A1 — small cover cup", codes: ["SUBSTITUTION"], images: ["bearing_cup_191440a1.jpg"] },
  "248118A1": { name: "Bearing cone 248118A1 — inboard bevel pinion", codes: ["ORIENTATION"], images: ["bearing_cone_248118a1_pos_correct_1.jpg", "bearing_cone_248118a1_flip.jpg"] },
  "67190R91": { name: "Bearing cone 67190R91 — upper pinion", codes: ["ORIENTATION"], images: ["bearing_cone_67190r91_pos_correct_1.jpg", "bearing_cone_67190r91_flip.jpg"] },
  "191711A1": { name: "Shim .101 — bevel pinion bearing (191711A1)", codes: ["SUBSTITUTION", "OUT_OF_SPEC"], images: ["IMG_3081.jpg"] },
  "191712A1": { name: "Shim .130 — bevel pinion bearing (191712A1)", codes: ["SUBSTITUTION", "OUT_OF_SPEC"], images: ["IMG_3080.jpg"] },
  "191713A1": { name: "Spacer / retainer shim ring (191713A1)", codes: ["SUBSTITUTION"], images: ["IMG_3074.jpg"] },
  "92203637": { name: "Ring retainer, thick 92203637", codes: ["SUBSTITUTION", "ORIENTATION"], images: ["part_n_92203637.jpg"] },
  "92203640": { name: "Ring, snap retainer 92203640", codes: ["SUBSTITUTION"], images: ["part_n_92203640.jpg"] },
  "229515A2": { name: "External retaining ring 229515A2 (C-ring)", codes: ["SUBSTITUTION"], images: ["ring_retainer_229515A2.jpg"] },
  "837-12030": { name: "Dowel pin 12.018 × 30 mm (837-12030)", codes: ["SUBSTITUTION"], images: ["IMG_3077.jpg"] },
  "14441231": { name: "Screw hex-soc M6×12 (14441231)", codes: ["SUBSTITUTION"], images: ["IMG_3076.jpg"] },
  "628-8016": { name: "Bolt M8×16 10.9 PHC (628-8016)", codes: ["EXTRA_OBJECT"], images: ["IMG_3075.jpg"] },
  "3187.111.180.00": { name: "Press driver cod.3187.111.180.00 (Step 6 cone)", codes: ["SUBSTITUTION"], images: ["driver_3187_111_180_00.jpg"] },
  "3187.111.100.27": { name: "Punch fixture cod.3187.111.100.27 (Step 8 retainer)", codes: ["SUBSTITUTION"], images: ["driver_3187_111_100_27.jpg"] },
  "3187.111.100.28": { name: "Driver cod.3187.111.100.28 (Step 14 shim pack)", codes: ["SUBSTITUTION"], images: ["driver_3187_111_100_28.jpg"] },
};

/**
 * Everything the glasses backend loads at boot, mapped one-to-one to PG-04.
 * `file` entries are vendored copies served at /shared-data; `repoPath`
 * entries are reference links into the glasses repo (source of truth) for
 * material too big to vendor (PDFs, images, audio).
 */
const GLASSES_ARTIFACTS: Array<
  Pick<KbArtifact, "name" | "type" | "note"> & { file?: string; repoPath?: string }
> = [
  { name: "ST.100 pinion cover procedure — 17 steps", type: "csv", file: "pinion-guide-steps-st100.csv", note: "Step titles, VLM image refs, correct/wrong CV identities per step (glasses build)" },
  { name: "Comer ↔ CNH parts catalogue v2", type: "other", file: "pinion-parts-catalogue.json", note: "Per-SKU visual fingerprints the VLM uses to tell lookalike parts apart" },
  { name: "Comer product catalogue (primary LLM knowledge)", type: "other", file: "comer-catalogue.json", note: "Driveshaft / TCs spec catalogue — first knowledge block in every glasses /query prompt" },
  { name: "Torque table", type: "csv", file: "torque-table.csv", note: "Torque specs the warning logic checks values against" },
  { name: "Tolerance spec", type: "csv", file: "tolerances.csv", note: "Acceptance ranges per measurement step" },
  { name: "Shim SKU lookup", type: "csv", file: "shim-sku-lookup.csv", note: "Measured gap → correct shim SKU (S07 wrong-shim warning)" },
  { name: "Historical error rates", type: "csv", file: "error-rates.csv", note: "Defect rates per step — grounds the 'most common mistakes' answers" },
  { name: "Operator tribal knowledge — 11 narrated recordings", type: "other", repoPath: "backend/data/supervisor-knowledge", note: "Matteo + Mohammed audio-transcribed facts — AUTHORITATIVE shop-floor notes in the glasses prompt; mirrored in chat retrieval here" },
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
    const noteParts = [
      steps.length ? `ST.100 ${steps.join(" · ")}` : "recognition-only (not in current procedure)",
      decoy?.warning ? `glasses fire: ${decoy.warning.headline} — ${decoy.warning.action}` : null,
    ].filter(Boolean);
    components.push({
      id: `glasses-${sku}`,
      name: cfg.name,
      note: noteParts.join(" · "),
      errorCodes: validErrorCodes(cfg.codes),
      images: cfg.images.map((f) => ({
        id: `glasses-img-${f}`,
        name: f,
        url: `${GLASSES_IMG_BASE}/${f}`,
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
      id: `glasses-art-${a.file ?? a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
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

  // Merge: glasses-sourced entries (glasses-* ids) are refreshed in place so a
  // seed-version bump updates them; anything a manager added by hand is kept.
  const mergeById = <T extends { id: string }>(existing: T[], seeded: T[]): T[] => {
    const bySeedId = new Map(seeded.map((s) => [s.id, s]));
    const kept = existing.map((e) => bySeedId.get(e.id) ?? e);
    const present = new Set(kept.map((e) => e.id));
    return [...kept, ...seeded.filter((s) => !present.has(s.id))];
  };
  bucket.components = mergeById(bucket.components, components);
  bucket.artifacts = mergeById(bucket.artifacts, artifacts);
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

    const result = await llmCall({ system, user, maxTokens: 1600 });

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
