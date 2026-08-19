/**
 * The Rockford line's station catalog — one shared source of truth.
 *
 * Two different consumers need the same facts and must not drift apart: the
 * knowledge base (which station has trained procedure material) and the MES
 * layer (which station number the line is writing phases against). Previously
 * only the first existed, which is why line questions could reach one station
 * and knowledge questions another.
 *
 * The distinction that matters throughout: **live MES activity is available for
 * every station on the line** via direct SQL, while **trained procedure and
 * component knowledge exists for ST100 only**. Those are independent axes, and
 * conflating them either hides the line or overstates what we can guide on.
 */

/**
 * The real Rockford line, one entry per sheet of Full_stations_report.xlsx
 * (MES acquisition export). The digital-twin capture and its hotspots all
 * live INSIDE the pinion guide station (ST100 = pg-04) — the other entries
 * here are genuinely different stations on the line.
 *
 * `report` = extracted from the station's sheet: MES phase count, number of
 * acquisition checks in the snapshot, and how many passed their min/max
 * limits. The per-station CSV is vendored at shared/data/stations-report/.
 */
export const STATIONS = [
  {
    id: "pg-04",
    label: "ST100 · Pinion Guide",
    stage: "Stage 1 · data collection complete",
    desc: "Pinion cover pre-assembly — pilot: glasses + digital twin live",
    tier: "core", flow: "main", stageNo: 1,
    active: true,
    procedureId: "proc:pinion-guide",
    // The pinion guide runs FOUR distinct procedures (Matteo, Jun 1 visit —
    // supervisor-knowledge facts): 425 front / 425 rear / 600 front / 600
    // rear. Everything trained here + on the glasses (the 17-step recipe,
    // components, POVs, digital twin) is the 425 REAR axle procedure. The
    // 600 series is a separate recipe: more steps, different bearings and
    // seals, and the highest error rate of the four. 425 builds use standard
    // drawings — no part-code matching (fixture 3187.A00.020.0 part matrix).
    procedures: {
      variants: [
        { id: "425-front", label: "425 front axle", trained: false },
        { id: "425-rear", label: "425 rear axle", trained: true },
        { id: "600-front", label: "600 front axle", trained: false },
        { id: "600-rear", label: "600 rear axle", trained: false },
      ],
      note:
        "All knowledge below (17-step recipe, components, POVs, digital twin) is the 425 rear axle " +
        "procedure. 600 series = separate recipe — more steps, different bearings/seals, highest " +
        "error rate of the four (Matteo). 425 uses standard drawings, no part-code matching.",
      matrixImage: "/lab/assets/rear-axle-425-procedure-matrix.jpg",
      matrixLabel: "Fixture 3187.A00.020.0 — part matrix per axle model",
    },
    report: { sheet: "ST100", phases: 17, checks: 96, ok: 86, nok: 10, sample: "bearing cups · inf/sup bearing press · shim pack · ring retainer · rolling torque" },
  },
  { id: "st110", label: "ST110 · Brake & Cover", stage: "Stage 2", desc: "Expanding plug · bearing cone · LH diff carrier assy", tier: "core", flow: "main", stageNo: 2, active: false, procedureId: null,
    report: { sheet: "ST110", phases: 3, checks: 6, ok: 4, nok: 2, sample: "expanding plug · bearing cone · carrier bearing assy" } },
  { id: "st130-135", label: "ST130-135 · Shimming", stage: "Stage 8", desc: "Diff carrier bolts · preload · shims · brake shim check", tier: "core", flow: "main", stageNo: 8, active: false, procedureId: null,
    report: { sheet: "ST130-135", phases: 20, checks: 143, ok: 140, nok: 3, sample: "bolt on diff carrier · carrier height · preload · shim tot · brake shim check" } },
  { id: "st140", label: "ST140 · Brake Complete", stage: "Stage 9", desc: "Brake piston bore · self-adjust stack", tier: "core", flow: "main", stageNo: 9, active: false, procedureId: null,
    report: { sheet: "ST140", phases: 10, checks: 138, ok: 116, nok: 22, sample: "brake piston bore · self adjust 1-3 · self adjust washers" } },
  { id: "st150", label: "ST150 · Pinion Complete & Brake Test", stage: "Stage 10", desc: "Cover to housing · manifold bolts · elbows · plugs", tier: "core", flow: "main", stageNo: 10, active: false, procedureId: null,
    report: { sheet: "ST150", phases: 28, checks: 104, ok: 102, nok: 2, sample: "bolt on clip · tube nut onto elbow · pinion cover on housing · M27x2" } },
  { id: "st160", label: "ST160 · Axle Mount", stage: "Stage 12-13 · with ST170", desc: "500QT bolt tightening — axle mount", tier: "core", flow: "main", stageNo: 12, active: false, procedureId: null,
    report: { sheet: "ST160", phases: 1, checks: 45, ok: 45, nok: 0, sample: "P160 bolts — torque acquisitions" } },
  { id: "st170", label: "ST170 · Axle Mount", stage: "Stage 12-13 · with ST160", desc: "500QT bolt tightening — axle mount", tier: "core", flow: "main", stageNo: 13, active: false, procedureId: null,
    report: { sheet: "ST170", phases: 1, checks: 27, ok: 26, nok: 1, sample: "P170 bolts — torque acquisitions" } },
  // One MES sheet (ST180_190) covers both physical test areas: the leak-test
  // station (stazione prova di tenuta) on the open floor and the stage-14
  // test bench in Bay 1 — the map draws both spots, both open this station.
  { id: "st180-190", label: "ST180-190 · Prova di Tenuta + Test Bench", stage: "Leak test + Stage 14", desc: "Leakage · filling · brake tests · run-in · pollution", tier: "outer", flow: "main", stageNo: 14, active: false, procedureId: null,
    report: { sheet: "ST180_190", phases: 15, checks: 86, ok: 86, nok: 0, sample: "leakage QTR · filling · parking/service brake test · run-in" } },
  { id: "st200-220", label: "ST200-220 · Subdifferential", stage: "Stage 5 · sub", desc: "Riveting · thrust washer · diff bolts · bearing cup", tier: "outer", flow: "sub", stageNo: 5, active: false, procedureId: null,
    report: { sheet: "ST200_220", phases: 10, checks: 67, ok: 64, nok: 3, sample: "riveter · thrust washer · diff bolts · bearing cup" } },
  { id: "st300", label: "ST300 · Tear Dropbox", stage: "Stage 11 · with ST310", desc: "Gear bearing cups/cones · backlash", tier: "outer", flow: "main", stageNo: 11, active: false, procedureId: null,
    report: { sheet: "ST300", phases: 9, checks: 30, ok: 4, nok: 26, sample: "small/big gear bearing cup · bearing cone press · backlash" } },
  { id: "st310", label: "ST310 · Tear Dropbox", stage: "Stage 11 · with ST300", desc: "Dropbox on center housing · plugs · Loctite", tier: "outer", flow: "main", stageNo: 11, active: false, procedureId: null,
    report: { sheet: "ST310", phases: 6, checks: 123, ok: 122, nok: 1, sample: "dropbox on center housing DX/SX · plug M18x1.5 · Loctite" } },
  // On the floor plan (Bay 6, "STAGE 3 SUB") but absent from the MES export.
  // Per Mohammed (Comer mechanical engineer): the report covers a Quad Track
  // axle build; ST400 is the axle mount for the LW and SW models, so it saw
  // no acquisitions in this snapshot. ST400 vs ST500 usage follows the model.
  { id: "st400-410", label: "ST400-410 · Subassembly", stage: "Stage 3 · sub", desc: "Axle mount for LW / SW models — idle in this Quad Track report", tier: "outer", flow: "sub", stageNo: 3, active: false, procedureId: null,
    report: null },
  { id: "st500-520", label: "ST500-520 · Sub Starship", stage: "Stage 6 · sub", desc: "Cone/cup bearing onto shaft · nut tighten · plugs", tier: "outer", flow: "sub", stageNo: 6, active: false, procedureId: null,
    report: { sheet: "ST500_510_520", phases: 8, checks: 125, ok: 75, nok: 50, sample: "cone bearing onto shaft · cup bearing · nut tighten · bolts on nut" } },
  { id: "st710", label: "ST700-710 · Subassembly", stage: "Stage 4 · sub", desc: "Pin positioning · Victory release/tightening cycles", tier: "outer", flow: "sub", stageNo: 4, active: false, procedureId: null,
    report: { sheet: "ST710", phases: 12, checks: 35, ok: 34, nok: 1, sample: "pin positioning 1-2 · Victory release/tightening 1-2" } },
] as const;

export type StationId = (typeof STATIONS)[number]["id"];

/**
 * MES `Station_Number` → catalog entry.
 *
 * The MES numbers each physical station, while the catalog groups some of them
 * the way the floor and the report do: ST130–135 are one shimming cell, ST180
 * and ST190 share a MES sheet, ST200–220 are one subdifferential area. Mapping
 * is therefore many-to-one and cannot be derived from the id string.
 */
const MES_NUMBER_TO_ID: Readonly<Record<number, StationId>> = {
  100: "pg-04",
  110: "st110",
  120: "st130-135",   // ST120 appears in MES traffic; shimming cell range
  130: "st130-135", 131: "st130-135", 132: "st130-135",
  133: "st130-135", 134: "st130-135", 135: "st130-135",
  140: "st140",
  150: "st150",
  160: "st160",
  170: "st170",
  180: "st180-190", 190: "st180-190",
  200: "st200-220", 210: "st200-220", 220: "st200-220",
  300: "st300",
  310: "st310",
  400: "st400-410", 410: "st400-410",
  500: "st500-520", 510: "st500-520", 520: "st500-520",
  700: "st710", 710: "st710",
};

export type Station = (typeof STATIONS)[number];

/** Every MES station number the line uses, ascending. */
export const MES_STATION_NUMBERS: readonly number[] = Object.keys(MES_NUMBER_TO_ID)
  .map(Number)
  .sort((a, b) => a - b);

/** Catalog id → the MES station numbers that map to it, ascending. */
function mesNumbersFor(id: StationId): number[] {
  return MES_STATION_NUMBERS.filter((n) => MES_NUMBER_TO_ID[n] === id);
}

/** The last station on the main flow — where a finished axle leaves the line. */
const endOfLine = () =>
  STATIONS.filter((s) => s.flow === "main").reduce((a, b) =>
    b.stageNo > a.stageNo ? b : a,
  );

/**
 * Line topology for a prompt.
 *
 * Without this the model reads the line off the station numbers, which is
 * wrong in a way that produces confident bad numbers: ST710 is the highest
 * number but it is a Stage 4 subassembly, so counting "units built" there
 * counts pins, not axles. The main flow runs by stage, and four ranges are
 * feeders that never see a finished unit.
 */
export function topologyForPrompt(): string {
  const fmt = (s: Station) =>
    `${s.label} [Station_Number ${mesNumbersFor(s.id).join(", ")}] — ${s.stage}`;
  const main = STATIONS.filter((s) => s.flow === "main").sort(
    (a, b) => a.stageNo - b.stageNo,
  );
  const subs = STATIONS.filter((s) => s.flow === "sub").sort(
    (a, b) => a.stageNo - b.stageNo,
  );
  const last = endOfLine();
  const lastNumber = Math.max(...mesNumbersFor(last.id));
  const firstNumber = Math.min(...mesNumbersFor(main[0]!.id));

  return [
    "LINE TOPOLOGY — station numbers are NOT the build order. Use this:",
    "",
    "Main flow, in order:",
    ...main.map((s, i) => `  ${i + 1}. ${fmt(s)}`),
    "",
    "Subassembly feeders — these build components that join the main flow.",
    "A serial here is NOT a finished axle:",
    ...subs.map((s) => `  - ${fmt(s)}`),
    "",
    `END OF LINE = Station_Number ${lastNumber} (${last.stage}).`,
    `START OF LINE = Station_Number ${firstNumber}.`,
    "",
    "COUNTING UNITS — the MES has no build or order table, so a 'unit' is a",
    "distinct serial (SN in SSL_ResPhase). Which station you count at decides",
    "the number, so use these definitions and alias the column so the choice is",
    "visible downstream (e.g. units_completed_at_190):",
    `  - units built / produced / completed / output / throughput  ->  COUNT(DISTINCT CAST(SN AS nvarchar(64))) WHERE Station_Number = ${lastNumber}`,
    `  - units started                                             ->  same, WHERE Station_Number = ${firstNumber}`,
    "  - serials touched anywhere on the line                      ->  same, no station filter (this is NOT output)",
    "Never count output at a subassembly feeder.",
    "When comparing two periods, both sides MUST come from ONE query with the",
    "identical station filter — grouping by date is the way to do it. Counting",
    "one day at one station and the other day line-wide is a wrong answer.",
  ].join("\n");
}

export function stationForMesNumber(n: number): Station | null {
  const id = MES_NUMBER_TO_ID[n];
  return id ? (STATIONS.find((s) => s.id === id) ?? null) : null;
}

/** `ST150 · Pinion Complete & Brake Test` for a MES number, or `ST150`. */
export function stationLabelForMesNumber(n: number): string {
  const s = stationForMesNumber(n);
  if (!s) return `ST${n}`;
  // The catalog label already carries the station code for single-number
  // stations; for grouped ones keep the specific number the MES reported.
  return s.label.startsWith(`ST${n} `) ? s.label : `ST${n} (${s.label})`;
}

/** Does the platform hold trained procedure material for this MES station? */
export function isTrainedMesStation(n: number): boolean {
  const s = stationForMesNumber(n);
  return Boolean(s?.procedureId);
}

/**
 * Coverage statement for a prompt.
 *
 * Written for a model that must be precise when asked what it can actually
 * guide on, without hiding the rest of the line: every station is queryable for
 * live activity, one station is trained to step level.
 */
export function coverageForPrompt(): string {
  const trained = STATIONS.filter((s) => s.procedureId);
  const rest = STATIONS.filter((s) => !s.procedureId);
  return [
    "PLATFORM COVERAGE — two independent things, do not conflate them:",
    "",
    "1. LIVE MES DATA: available for EVERY station on the line. Any station's",
    "   current activity, phase history, serials, operators, measurements and",
    "   pass/fail results can be queried. The whole line is in scope by default.",
    "",
    "2. TRAINED PROCEDURE KNOWLEDGE (step-by-step recipe, component recognition,",
    "   operator/tribal knowledge, POV recordings, digital twin) — only:",
    ...trained.map(
      (s) =>
        `   - ${s.label} (${s.stage}). Trained on the 425 REAR axle procedure` +
        " specifically; the 425-front and 600-series recipes are NOT trained.",
    ),
    "",
    "   NOT trained (live MES data yes, step-level guidance no):",
    ...rest.map((s) => `   - ${s.label} — ${s.stage}`),
    "",
    "So: answer questions about ANY station's live state, throughput, failures or",
    "history from the MES. But if asked how to perform a step, what a component",
    "should look like, or what commonly goes wrong procedurally at a station other",
    "than the trained one, say plainly that the procedure for that station is not",
    "trained yet and offer the MES data you do have. NEVER transfer a pinion-guide",
    "procedural fact to another station.",
  ].join("\n");
}
