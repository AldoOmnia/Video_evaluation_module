/**
 * Direct read-only access to Comer's UNICOMM MES database (SSL04_FARGO).
 *
 * The platform used to reach SQL only through the glasses backend's
 * `/v1/unicomm/*` façade, which meant a second repo on a specific branch, a
 * second process and a second .env just to answer "what is the line doing?".
 * This talks to the database directly: six environment variables, no bridge.
 *
 * Two things this module exists to guarantee.
 *
 * 1. It can never write. The natural-language path lets a model compose SQL, so
 *    "the login is read-only" cannot be the only defence — Comer's credential is
 *    a sysadmin account today. `assertReadOnly` is a deny-by-default gate on
 *    every statement, and every session is opened READ UNCOMMITTED so a
 *    reporting query can never take locks that block the plant's own writes.
 *
 * 2. It never lies about time. SSL_ResPhase.Phase_Date is a SQL `datetime`,
 *    which carries no offset, and the plant writes it in Rockford wall-clock
 *    time. The driver hands those bare digits back tagged UTC, so a phase
 *    stamped 30 seconds ago reads five hours old. Verified on site: the newest
 *    row matched America/Chicago to within six seconds, while UTC was 300
 *    minutes off and the DB host's own clock (it sits in Italy, UTC+2) was 420
 *    minutes off. Everything leaving this module carries a resolved instant.
 */
import sql from "mssql";
import { isTrainedMesStation, stationLabelForMesNumber } from "./stations.js";

/* ── Configuration ────────────────────────────────────────────────────────── */

export interface MesConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  /** Station the platform treats as "the" line by default (Pinion Guide). */
  stationNumber: number;
  /** Test program whose published step set the assistant knows. */
  testNumber: string;
}

const envBool = (key: string, dflt: boolean): boolean => {
  const raw = process.env[key]?.trim();
  if (raw == null || raw === "") return dflt;
  return !(raw === "0" || /^false$/i.test(raw));
};

export function mesConfig(): MesConfig {
  return {
    host: process.env.MES_MSSQL_HOST?.trim() ?? "",
    port: Number(process.env.MES_MSSQL_PORT ?? 1433),
    database: process.env.MES_MSSQL_DATABASE?.trim() || "SSL04_FARGO",
    user: process.env.MES_MSSQL_USER?.trim() ?? "",
    encrypt: envBool("MES_MSSQL_ENCRYPT", true),
    trustServerCertificate: envBool("MES_MSSQL_TRUST_CERT", true),
    stationNumber: Number(process.env.MES_STATION_NUMBER ?? 100),
    testNumber: process.env.MES_TEST_NUMBER?.trim() || "X900.SWR.901.A01",
  };
}

/** Configured enough to try connecting. */
export function mesConfigured(): boolean {
  const c = mesConfig();
  return Boolean(c.host && c.user && process.env.MES_MSSQL_PASSWORD);
}

/* ── Plant-local time ─────────────────────────────────────────────────────── */

export const PLANT_TZ = process.env.MES_PLANT_TZ?.trim() || "America/Chicago";

/**
 * Read bare `YYYY-MM-DDTHH:MM:SS` digits as wall time in `tz`.
 *
 * The gap between "those digits read as UTC" and "how that instant looks in the
 * zone" is the zone's offset for that date, so DST is handled without pulling
 * in a timezone library. Ambiguous only inside a transition hour, where being
 * an hour out does not change any decision this data drives.
 */
export function wallTimeToInstant(value: unknown, tz: string = PLANT_TZ): Date | null {
  if (value == null) return null;
  const naive = value instanceof Date ? value.toISOString() : String(value);
  const digits = naive.replace(/(\.\d+)?Z?$/, "");
  const asIfUtc = new Date(`${digits}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;
  const inZone = new Date(
    `${asIfUtc.toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T")}Z`,
  );
  return new Date(asIfUtc.getTime() + (asIfUtc.getTime() - inZone.getTime()));
}

/** `2026-08-19 06:46:18` — plant wall clock, the form an operator would read. */
export function plantClock(value: unknown): string | null {
  if (value == null) return null;
  const naive = value instanceof Date ? value.toISOString() : String(value);
  const m = naive.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * A Date whose UTC digits equal the plant wall clock — the only safe way to
 * compare against `Phase_Date` from Node.
 *
 * The driver serialises a Date using its UTC components, and Phase_Date holds
 * plant-local digits, so binding a plain `new Date()` would filter five hours
 * off. `GETDATE()` is worse and must never be used for this: the database host
 * sits in Italy, so its own clock is seven hours away from the digits in the
 * column it would be compared against.
 */
export function plantWallClockAsDbDate(at: Date = new Date()): Date {
  const digits = at.toLocaleString("sv-SE", { timeZone: PLANT_TZ }).replace(" ", "T");
  return new Date(`${digits}Z`);
}

export function humanAge(ms: number, lang: "en" | "it" = "en"): string {
  const mins = Math.round(ms / 60000);
  if (mins < 0) return lang === "it" ? "adesso" : "just now";
  if (mins < 1) return lang === "it" ? "meno di un minuto" : "less than a minute";
  if (mins === 1) return lang === "it" ? "1 minuto" : "1 minute";
  if (mins < 60) return lang === "it" ? `${mins} minuti` : `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hs =
    lang === "it" ? (h === 1 ? "1 ora" : `${h} ore`) : h === 1 ? "1 hour" : `${h} hours`;
  if (!m) return hs;
  return lang === "it" ? `${hs} e ${m} minuti` : `${hs} ${m} minutes`;
}

/* ── Read-only guard ──────────────────────────────────────────────────────── */

export class UnsafeQueryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnsafeQueryError";
  }
}

/**
 * Statement keywords that must never reach a production MES, matched as whole
 * words after comments and string literals are stripped.
 *
 * `INTO` is here because `SELECT … INTO newtable` creates a table — a write
 * dressed as a SELECT, and the reason "it starts with SELECT" is not a
 * sufficient check. `WAITFOR` is here because it can stall a pooled connection.
 */
const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE",
  "MERGE", "INTO", "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY",
  "BACKUP", "RESTORE", "SHUTDOWN", "RECONFIGURE", "KILL", "WAITFOR",
  "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "BULK", "SET", "USE",
  "DBCC", "TRIGGER", "PROCEDURE", "FUNCTION", "TRANSACTION", "COMMIT",
  "ROLLBACK", "SAVE", "GO",
];

/** Comments and string literals hide keywords from a naive scan. */
function scrub(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\[[^\]]*\]/g, "_bracketed_");
}

/**
 * Deny-by-default gate. Throws `UnsafeQueryError` unless the statement is a
 * single, self-contained SELECT.
 */
export function assertReadOnly(sqlText: string): void {
  const raw = String(sqlText ?? "").trim();
  if (!raw) throw new UnsafeQueryError("empty statement");
  if (raw.length > 4000) throw new UnsafeQueryError("statement too long");

  const scrubbed = scrub(raw);

  // Multiple statements: allow a single trailing semicolon, nothing after it.
  if (/;\s*\S/.test(scrubbed)) {
    throw new UnsafeQueryError("multiple statements are not allowed");
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(scrubbed)) {
    throw new UnsafeQueryError("only SELECT statements are allowed");
  }
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, "i").test(scrubbed)) {
      throw new UnsafeQueryError(`'${word}' is not allowed in a read-only query`);
    }
  }
  // sp_/xp_ procedures never appear in a legitimate reporting SELECT.
  if (/\b(sp|xp)_\w+/i.test(scrubbed)) {
    throw new UnsafeQueryError("stored procedures are not allowed");
  }
}

/* ── Pool ─────────────────────────────────────────────────────────────────── */

let pool: sql.ConnectionPool | null = null;
let connecting: Promise<sql.ConnectionPool> | null = null;
let lastError: string | null = null;
let connectedAt: number | null = null;

const QUERY_TIMEOUT_MS = Number(process.env.MES_QUERY_TIMEOUT_MS ?? 15_000);
/** Hard ceiling on rows handed back, so one bad query cannot flood memory. */
export const MAX_ROWS = Number(process.env.MES_MAX_ROWS ?? 200);

async function getPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool;
  if (connecting) return connecting;

  const c = mesConfig();
  connecting = (async () => {
    const p = new sql.ConnectionPool({
      server: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password: process.env.MES_MSSQL_PASSWORD ?? "",
      options: {
        encrypt: c.encrypt,
        trustServerCertificate: c.trustServerCertificate,
        appName: "omnia-comer-platform",
        readOnlyIntent: true,
      },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
      connectionTimeout: 20_000,
      requestTimeout: QUERY_TIMEOUT_MS,
    });
    // A dropped pool must not be reused; the next call reconnects.
    p.on("error", (e) => {
      lastError = e instanceof Error ? e.message : String(e);
      pool = null;
      connectedAt = null;
    });
    await p.connect();
    pool = p;
    connectedAt = Date.now();
    lastError = null;
    return p;
  })();

  try {
    return await connecting;
  } catch (e) {
    pool = null;
    connectedAt = null;
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    connecting = null;
  }
}

/**
 * Run a guarded read-only SELECT.
 *
 * READ UNCOMMITTED is set per request rather than per statement: this is a
 * reporting overlay on a live production database, and blocking the plant's own
 * inserts to get a dashboard number would be a genuinely bad trade. Dirty reads
 * are acceptable for "how many units this shift"; they are never used to make a
 * quality decision.
 */
export type QueryParam = string | number | Date;

export async function mesQuery<T = Record<string, unknown>>(
  sqlText: string,
  params: Record<string, QueryParam> = {},
): Promise<{ rows: T[]; truncated: boolean; elapsedMs: number }> {
  assertReadOnly(sqlText);
  const started = Date.now();
  const p = await getPool();
  const request = p.request();
  for (const [k, v] of Object.entries(params)) request.input(k, v);

  const result = await request.query<T>(
    `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; ${sqlText}`,
  );
  const all = (result.recordset ?? []) as T[];
  return {
    rows: all.slice(0, MAX_ROWS),
    truncated: all.length > MAX_ROWS,
    elapsedMs: Date.now() - started,
  };
}

export interface MesHealth {
  configured: boolean;
  connected: boolean;
  host: string | null;
  database: string | null;
  user: string | null;
  connectedAt: string | null;
  serverTimeUtc: string | null;
  /** Newest phase row anywhere on the line — the "is the plant moving?" signal. */
  newestPhaseAt: string | null;
  newestPhaseAge: string | null;
  error: string | null;
}

export async function mesHealth(lang: "en" | "it" = "en"): Promise<MesHealth> {
  const c = mesConfig();
  const base: MesHealth = {
    configured: mesConfigured(),
    connected: false,
    host: c.host || null,
    database: c.database || null,
    user: c.user || null,
    connectedAt: null,
    serverTimeUtc: null,
    newestPhaseAt: null,
    newestPhaseAge: null,
    error: null,
  };
  if (!base.configured) {
    base.error = "MES_MSSQL_HOST / USER / PASSWORD are not set";
    return base;
  }
  try {
    const { rows } = await mesQuery<{ utc: Date; newest: Date | null }>(
      `SELECT SYSUTCDATETIME() AS utc,
              (SELECT MAX(Phase_Date) FROM dbo.SSL_ResPhase) AS newest`,
    );
    const row = rows[0];
    const newest = wallTimeToInstant(row?.newest ?? null);
    return {
      ...base,
      connected: true,
      connectedAt: connectedAt ? new Date(connectedAt).toISOString() : null,
      serverTimeUtc: row?.utc ? new Date(row.utc).toISOString() : null,
      newestPhaseAt: plantClock(row?.newest ?? null),
      newestPhaseAge: newest ? humanAge(Date.now() - newest.getTime(), lang) : null,
    };
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    return base;
  }
}

/* ── Schema ───────────────────────────────────────────────────────────────── */

/**
 * The tables the assistant is allowed to see, in the order a person would need
 * them explained. An allow-list rather than "whatever is in the database":
 * SSL04_FARGO carries hundreds of objects, most of them UNICOMM internals, and
 * dumping all of them into a prompt buys hallucinated joins rather than better
 * answers.
 */
const TABLE_NOTES: Record<string, string> = {
  SSL_ResPhase:
    "Recorded phase results — the live history of the line. One row per phase " +
    "completed at a station. Station_Number scopes it; Phase_Date is plant-local. " +
    "This is the table for 'what happened / what is happening / how many units'.",
  SSL_ResPhase1:
    "Analog measurements for a recorded phase (torque, force, position). " +
    "Value_Acq with [min]/[max] limits and Status_Acq pass/fail.",
  SSL_Phase:
    "Published step list per test program (Test_Number + Station_Number → " +
    "Phase_Number, Phase_ID). The procedure definition, not what happened.",
  SSL_PhaseDescription: "Human descriptions for a Phase_ID.",
  SSL_PhaseAnalog: "Configured measurement limits per Phase_ID.",
  SSL_Stations_Tree: "Station master data: Station_Number, Station_Name, Device_Name.",
  SSL_Test: "Test program header: Test_Number, DUT_Type, Description.",
  SSL_Users:
    "EMPTY in this deployment — 0 rows, verified against the live database. " +
    "Comer does not populate it, so operator NAMES are not available anywhere " +
    "in this schema. Do NOT join this table: it only turns a good answer into " +
    "a NULL. Operator identity is SSL_ResPhase.Operator_ID, a badge number " +
    "(e.g. '2406'); report that number as the operator.",
  Production_Manager:
    "EMPTY in this deployment — 0 rows, verified against the live database. It " +
    "would carry Sequence/OP/SN/Model, so it is the obvious place to look for a " +
    "unit's MODEL, but there is nothing in it. Do NOT join it: it only turns a " +
    "good answer into a NULL. There is no model/product name for a serial " +
    "anywhere in this schema — identify the product from the test program " +
    "instead (SSL_Phase.Test_Number → SSL_Test.Description).",
};

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
}
export interface SchemaTable {
  name: string;
  note: string;
  columns: SchemaColumn[];
}

let schemaCache: { at: number; tables: SchemaTable[] } | null = null;
const SCHEMA_TTL_MS = 10 * 60_000;

/** Real column names for the allow-listed tables, so SQL is never invented. */
export async function mesSchema(): Promise<SchemaTable[]> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) {
    return schemaCache.tables;
  }
  const names = Object.keys(TABLE_NOTES);
  const list = names.map((n) => `'${n}'`).join(",");
  const { rows } = await mesQuery<{
    TABLE_NAME: string;
    COLUMN_NAME: string;
    DATA_TYPE: string;
    IS_NULLABLE: string;
    ORDINAL_POSITION: number;
  }>(
    `SELECT TOP (2000) TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME IN (${list})
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );

  const byTable = new Map<string, SchemaColumn[]>();
  for (const r of rows) {
    const cols = byTable.get(r.TABLE_NAME) ?? [];
    cols.push({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
    });
    byTable.set(r.TABLE_NAME, cols);
  }

  const tables: SchemaTable[] = names
    .filter((n) => byTable.has(n))
    .map((n) => ({ name: n, note: TABLE_NOTES[n], columns: byTable.get(n) ?? [] }));

  schemaCache = { at: Date.now(), tables };
  return tables;
}

/** SQL Server refuses to compare, group, sort or DISTINCT these legacy types. */
const UNSORTABLE = new Set(["text", "ntext", "image"]);

export function isUnsortable(type: string): boolean {
  return UNSORTABLE.has(type.toLowerCase());
}

/**
 * Compact schema rendering for a prompt.
 *
 * Legacy `text` columns are marked inline rather than left for the model to
 * infer from the type name. This database stores most of its human-readable
 * labels that way — Station_Name, Phase_Description — and those are exactly the
 * columns a question wants to group by, so an unmarked schema reliably produces
 * a query that SQL Server rejects.
 */
export function schemaForPrompt(tables: SchemaTable[]): string {
  return tables
    .map(
      (t) =>
        `TABLE dbo.${t.name}\n  -- ${t.note}\n  ${t.columns
          .map(
            (c) =>
              `${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}` +
              (isUnsortable(c.type) ? " [CAST to nvarchar to group/sort/compare]" : ""),
          )
          .join(", ")}`,
    )
    .join("\n\n");
}

/* ── Station snapshot ─────────────────────────────────────────────────────── */

/**
 * "What is this station doing right now", shaped like the connector's
 * `fetchWorkstationSnapshot()` so the existing home card and chat render it
 * unchanged.
 *
 * Where this deliberately differs from the connector: activity and step-mapping
 * are two separate questions, and conflating them makes a running line look
 * quiet.
 *
 * ST100 builds the same physical pinion procedure under several test programs,
 * one per axle variant. Verified against the live database: the tracked program
 * publishes its phases as `4900.12001 …` while the units on the line this
 * morning ran `4900.12000 …` and yesterday's ran `4900.11003 …` — identical
 * operation names and order, differing in the variant number. The connector
 * treats any unpublished Phase_ID as an idle session, so a station stamping a
 * phase every two minutes reported as idle all morning.
 *
 * The guard itself is right for the glasses, which must never arm a decoy
 * against a step it has mis-identified. It is wrong for answering "what is
 * happening right now". So:
 *
 *   • session_active comes from RECENCY — a phase written inside the idle window.
 *   • step_index / total_steps are claimed ONLY when the phase maps to the
 *     tracked program, because a step number we cannot verify is worse than none.
 *   • the live phase name, serial, operator and time are always reported: they
 *     come straight from the row and need no mapping to be true.
 */
export interface StationSnapshot {
  timestamp: number;
  station_id: string;
  station_number: number;
  test_number: string;
  session_active: boolean;
  step_index: number | null;
  total_steps: number | null;
  current_phase_number: number | null;
  current_step_title: string | null;
  current_phase_result: string | null;
  /** Plant wall clock, e.g. `2026-08-19 06:46:18`. Never a UTC ISO string. */
  last_phase_local_time: string | null;
  last_phase_timezone: string;
  last_phase_age: string | null;
  technician_id: string | null;
  technician_name: string | null;
  technician_dept: string | null;
  serial_number: string | null;
  model: string | null;
  measurements: Array<Record<string, unknown>>;
  /** The phase the line actually wrote, verbatim — true without any mapping. */
  current_phase_id: string | null;
  /** Whether that phase belongs to the tracked program's published step set.
   *  When false, step numbering is withheld rather than guessed. */
  program_mapped: boolean;
  /** Product the tracked program builds, e.g. `Small Wheel - 425`. */
  tracked_program_product?: string | null;
  program_note?: string;
}

/** How long after the last phase write a station still counts as working. */
const SESSION_IDLE_MS = Number(process.env.MES_SESSION_IDLE_MS ?? 15 * 60_000);

/**
 * Product name of the tracked test program, e.g. `Small Wheel - 425`.
 *
 * Worth a query because "a different axle variant" is abstract while "the line
 * is not on the 425 right now" is something a person on the floor can confirm or
 * contradict on the spot. Cached: this is configuration, not live data.
 */
let trackedProductCache: { tn: string; product: string | null } | null = null;

async function trackedProduct(testNumber: string): Promise<string | null> {
  if (trackedProductCache?.tn === testNumber) return trackedProductCache.product;
  try {
    const { rows } = await mesQuery<{ descr: string | null }>(
      `SELECT TOP (1) CAST(Description AS nvarchar(400)) AS descr
       FROM dbo.SSL_Test WHERE Test_Number = @tn`,
      { tn: testNumber },
    );
    // Descriptions carry newlines and trailing customer codes; keep the first line.
    const product = (rows[0]?.descr ?? "").split(/[\r\n]/)[0].trim() || null;
    trackedProductCache = { tn: testNumber, product };
    return product;
  } catch {
    return null;
  }
}

interface PhaseRow {
  ID: number;
  SN: string | null;
  Phase_Number: number | null;
  Phase_ID: string | null;
  Phase_Result: string | null;
  Phase_Description: string | null;
  Phase_Date: Date | null;
  Operator_ID: string | null;
}

export async function fetchStationSnapshot(
  lang: "en" | "it" = "en",
): Promise<StationSnapshot | null> {
  const cfg = mesConfig();

  const [latest, steps] = await Promise.all([
    mesQuery<PhaseRow>(
      `SELECT TOP (1) ID, SN, Phase_Number, Phase_ID, Phase_Result,
              Phase_Description, Phase_Date, Operator_ID
       FROM dbo.SSL_ResPhase
       WHERE Station_Number = @station
       ORDER BY Phase_Date DESC, ID DESC`,
      { station: cfg.stationNumber },
    ),
    mesQuery<{ Phase_Number: number; Phase_ID: string }>(
      `SELECT Phase_Number, Phase_ID
       FROM dbo.SSL_Phase
       WHERE Test_Number = @testNumber AND Station_Number = @station
       ORDER BY Phase_Number`,
      { testNumber: cfg.testNumber, station: cfg.stationNumber },
    ),
  ]);

  const row = latest.rows[0];
  const totalSteps = steps.rows.length || null;
  const knownPhaseIds = new Set(
    steps.rows.map((r) => String(r.Phase_ID ?? "").trim().toUpperCase()).filter(Boolean),
  );

  const instant = wallTimeToInstant(row?.Phase_Date ?? null);
  const base = {
    timestamp: Date.now(),
    station_id: String(cfg.stationNumber),
    station_number: cfg.stationNumber,
    test_number: cfg.testNumber,
    total_steps: totalSteps,
    last_phase_local_time: plantClock(row?.Phase_Date ?? null),
    last_phase_timezone: `${PLANT_TZ} (plant floor local time, NOT UTC)`,
    last_phase_age: instant ? humanAge(Date.now() - instant.getTime(), lang) : null,
  };

  if (!row) {
    return {
      ...base,
      session_active: false,
      step_index: null,
      current_phase_number: null,
      current_step_title: null,
      current_phase_result: null,
      technician_id: null,
      technician_name: null,
      technician_dept: null,
      serial_number: null,
      model: null,
      measurements: [],
      current_phase_id: null,
      program_mapped: false,
      program_note: `no phase rows recorded at station ${cfg.stationNumber}`,
    };
  }

  const phaseId = String(row.Phase_ID ?? "").trim().toUpperCase();
  const mapped = knownPhaseIds.size === 0 || knownPhaseIds.has(phaseId);
  const active = instant != null && Date.now() - instant.getTime() <= SESSION_IDLE_MS;
  const product = mapped ? null : await trackedProduct(cfg.testNumber);

  /* Unit metadata and measurements are nice-to-have: a failure here should
     degrade the snapshot, not lose the step the director asked about.

     Two lookups deliberately absent, both against tables that are empty in this
     deployment (verified, 0 rows) — joining either spends a round trip to
     produce NULL and invites the assistant to apologise for missing data as
     though something were broken:

       SSL_Users          → no operator names exist. Operator_ID is a badge
                            number, and that is the operator identity here.
       Production_Manager → no Model exists for any serial. The product is
                            identified from the test program instead. */
  const [measurements] = await Promise.all([
    row.SN && row.Phase_Number != null
      ? mesQuery<{
          Description_Acq: string | null;
          Min_Acq: number | null;
          Max_Acq: number | null;
          Value_Acq: number | null;
          Status_Acq: string | null;
        }>(
          `SELECT TOP (20) Description_Acq, [min] AS Min_Acq, [max] AS Max_Acq,
                  Value_Acq, Status_Acq
           FROM dbo.SSL_ResPhase1
           WHERE SN = @sn AND Station_Number = @station AND Phase_Number = @phase
           ORDER BY ID DESC`,
          { sn: String(row.SN), station: cfg.stationNumber, phase: row.Phase_Number },
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    ...base,
    session_active: active,
    // Withheld when unmapped: the phase number is real, but its position in the
    // tracked program's step list is not something we can honestly claim.
    step_index: mapped ? (row.Phase_Number ?? null) : null,
    total_steps: mapped ? base.total_steps : null,
    current_phase_id: row.Phase_ID ?? null,
    program_mapped: mapped,
    ...(mapped
      ? {}
      : {
          tracked_program_product: product,
          program_note:
            `the station is running phase "${row.Phase_ID}", which is NOT part of ` +
            `the tracked program ${cfg.testNumber}` +
            (product ? ` (${product})` : "") +
            ". The station is building a DIFFERENT axle model, so the step number " +
            "out of the tracked program's step list is unavailable. The phase name, " +
            "serial, operator badge and timestamp are live and accurate. This is " +
            "normal on a line that builds several models — it is not a fault.",
        }),
    current_phase_number: row.Phase_Number ?? null,
    current_step_title: row.Phase_Description ?? null,
    current_phase_result: row.Phase_Result ?? null,
    technician_id: row.Operator_ID ?? null,
    // Badge number is the only operator identity this database carries.
    technician_name: null,
    technician_dept: null,
    serial_number: row.SN ?? null,
    // No model/product name exists for a serial in this schema; the tracked
    // program's product is reported as tracked_program_product instead.
    model: null,
    measurements: (measurements?.rows ?? []).map((m) => ({
      label: m.Description_Acq,
      value: m.Value_Acq,
      min: m.Min_Acq,
      max: m.Max_Acq,
      verdict: m.Status_Acq,
      in_range:
        m.Value_Acq != null && m.Min_Acq != null && m.Max_Acq != null
          ? m.Value_Acq >= m.Min_Acq && m.Value_Acq <= m.Max_Acq
          : null,
    })),
  };
}

/* ── Line-wide snapshot ───────────────────────────────────────────────────── */

/**
 * What the WHOLE line is doing — the default context for a chat question.
 *
 * The single-station snapshot was the original context, and it quietly made the
 * assistant behave as though ST100 were the plant: asked about ST110 it would
 * answer, then volunteer that "the snapshot on screen is for ST100", and asked
 * about the line it described one station. A plant director's default scope is
 * the line, so that is what gets sent.
 *
 * One query, one row per station with activity inside the window. Station labels
 * come from the platform catalog rather than the MES `Station_Name` (which reads
 * `UNIFARGO-180`), and each row carries whether the platform has trained
 * procedure knowledge for it — so the assistant can be precise about what it can
 * guide on without pretending the rest of the line is invisible.
 */
export interface LineStationRow {
  station_number: number;
  station: string;
  phases_in_window: number;
  units_in_window: number;
  current_phase: string | null;
  current_result: string | null;
  serial: string | null;
  operator_badge: string | null;
  last_activity_local: string | null;
  last_activity_age: string | null;
  procedure_trained: boolean;
}

export interface LineSnapshot {
  plant_local_time: string | null;
  plant_timezone: string;
  window_minutes: number;
  active_station_count: number;
  stations: LineStationRow[];
}

export async function fetchLineSnapshot(
  lang: "en" | "it" = "en",
  windowMinutes = 30,
): Promise<LineSnapshot> {
  const since = plantWallClockAsDbDate(new Date(Date.now() - windowMinutes * 60_000));

  /* Latest row per station via a windowed rank, plus per-station counts in the
     same pass. Phase_ID/Phase_Description are CAST because several descriptive
     columns here are the legacy `text` type, which cannot be ranked or grouped. */
  const { rows } = await mesQuery<{
    Station_Number: number;
    phases: number;
    units: number;
    Phase_ID: string | null;
    Phase_Result: string | null;
    SN: string | null;
    Operator_ID: string | null;
    Phase_Date: Date | null;
  }>(
    `WITH recent AS (
       SELECT Station_Number, SN, Operator_ID, Phase_Date, Phase_Result,
              CAST(Phase_ID AS nvarchar(200)) AS Phase_ID,
              ROW_NUMBER() OVER (PARTITION BY Station_Number
                                 ORDER BY Phase_Date DESC, ID DESC) AS rn,
              COUNT(*)           OVER (PARTITION BY Station_Number) AS phases,
              COUNT(DISTINCT SN) OVER (PARTITION BY Station_Number) AS units
       FROM dbo.SSL_ResPhase
       WHERE Phase_Date >= @since
     )
     SELECT TOP (60) Station_Number, phases, units, Phase_ID, Phase_Result,
            SN, Operator_ID, Phase_Date
     FROM recent WHERE rn = 1
     ORDER BY Phase_Date DESC`,
    { since },
  );

  const stations: LineStationRow[] = rows.map((r) => {
    const instant = wallTimeToInstant(r.Phase_Date);
    return {
      station_number: r.Station_Number,
      station: stationLabelForMesNumber(r.Station_Number),
      phases_in_window: r.phases,
      units_in_window: r.units,
      current_phase: r.Phase_ID ?? null,
      current_result: r.Phase_Result ?? null,
      serial: r.SN ?? null,
      operator_badge: r.Operator_ID ?? null,
      last_activity_local: plantClock(r.Phase_Date),
      last_activity_age: instant ? humanAge(Date.now() - instant.getTime(), lang) : null,
      procedure_trained: isTrainedMesStation(r.Station_Number),
    };
  });

  return {
    plant_local_time: plantClock(plantWallClockAsDbDate()),
    plant_timezone: `${PLANT_TZ} (plant floor local time, NOT UTC)`,
    window_minutes: windowMinutes,
    active_station_count: stations.length,
    stations,
  };
}

/** Release the pool on shutdown so a restart never inherits a half-open socket. */
export async function mesClose(): Promise<void> {
  try {
    await pool?.close();
  } catch {
    /* shutting down anyway */
  }
  pool = null;
  connectedAt = null;
}

export function mesLastError(): string | null {
  return lastError;
}
