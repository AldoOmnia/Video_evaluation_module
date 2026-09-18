#!/usr/bin/env node
/**
 * What product is the line actually building right now?
 *
 * Raw SQL, printed verbatim, with NO language model anywhere in the path — the
 * point of this tool is that its output can be checked against what a person is
 * looking at on the floor. Every line below is a value straight out of
 * SSL04_FARGO; nothing is inferred, summarised or rephrased.
 *
 *   npx tsx tools/mes-whats-running.mjs [searchTerm]
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env"),
});

const { mesConfig, mesQuery, plantClock, plantWallClockAsDbDate } = await import(
  "../backend/src/services/mesSql.ts"
);

const term = process.argv[2] ?? "425";
const cfg = mesConfig();
const since60 = plantWallClockAsDbDate(new Date(Date.now() - 60 * 60_000));

const line = (s = "") => console.log(s);
const rule = (t) => line(`\n${"─".repeat(74)}\n${t}\n`);

line(`database ${cfg.database}@${cfg.host}   plant clock ${plantClock(plantWallClockAsDbDate())}`);

/* 1 ── Which units, and which MODEL, has the line touched in the last hour.
       Model comes from Production_Manager, joined by serial. */
rule("1. UNITS THE LINE HAS TOUCHED IN THE LAST 60 MINUTES (with model)");
const { rows: units } = await mesQuery(
  `SELECT TOP (60)
       r.SN,
       MIN(r.Station_Number) AS first_st,
       MAX(r.Station_Number) AS last_st,
       COUNT(*)              AS phases,
       MAX(r.Phase_Date)      AS newest,
       MAX(CAST(p.Model AS nvarchar(200))) AS model
   FROM dbo.SSL_ResPhase r
   LEFT JOIN dbo.Production_Manager p ON p.SN = r.SN
   WHERE r.Phase_Date >= @since
   GROUP BY r.SN
   ORDER BY MAX(r.Phase_Date) DESC`,
  { since: since60 },
);
line(`  ${"serial".padEnd(16)} ${"model".padEnd(30)} ph  stations   last activity`);
for (const u of units) {
  line(
    `  ${String(u.SN ?? "—").padEnd(16)} ${String(u.model ?? "(no Production_Manager row)").padEnd(30)} ` +
      `${String(u.phases).padStart(2)}  ${String(u.first_st)}–${String(u.last_st)}`.padEnd(12) +
      `  ${plantClock(u.newest)}`,
  );
}
line(`  → ${units.length} distinct serial(s) in the last hour`);

/* 2 ── Distinct models seen today, counted. */
rule("2. DISTINCT MODELS BUILT TODAY (by serial, from Production_Manager)");
const midnight = plantWallClockAsDbDate();
midnight.setUTCHours(0, 0, 0, 0);
const { rows: models } = await mesQuery(
  `SELECT CAST(p.Model AS nvarchar(200)) AS model,
          COUNT(DISTINCT r.SN) AS units,
          MAX(r.Phase_Date)    AS newest
   FROM dbo.SSL_ResPhase r
   LEFT JOIN dbo.Production_Manager p ON p.SN = r.SN
   WHERE r.Phase_Date >= @since
   GROUP BY CAST(p.Model AS nvarchar(200))
   ORDER BY COUNT(DISTINCT r.SN) DESC`,
  { since: midnight },
);
for (const m of models) {
  line(
    `  ${String(m.model ?? "(null)").padEnd(34)} ${String(m.units).padStart(3)} unit(s)   last ${plantClock(m.newest)}`,
  );
}

/* 3 ── Does the search term appear anywhere that identifies a product? */
rule(`3. DOES "${term}" APPEAR ANYWHERE AS A PRODUCT IDENTIFIER?`);
const like = `%${term}%`;

const { rows: pmHits } = await mesQuery(
  `SELECT TOP (30) CAST(Model AS nvarchar(200)) AS model, COUNT(*) AS rows_
   FROM dbo.Production_Manager
   WHERE CAST(Model AS nvarchar(200)) LIKE @like
   GROUP BY CAST(Model AS nvarchar(200))`,
  { like },
);
line(`  Production_Manager.Model matching "${term}": ${pmHits.length}`);
for (const h of pmHits) line(`    ${h.model}   (${h.rows_} rows)`);

const { rows: testHits } = await mesQuery(
  `SELECT TOP (30) Test_Number,
          CAST(DUT_Type AS nvarchar(200))    AS dut,
          CAST(Description AS nvarchar(400)) AS descr
   FROM dbo.SSL_Test
   WHERE Test_Number LIKE @like
      OR CAST(DUT_Type AS nvarchar(200)) LIKE @like
      OR CAST(Description AS nvarchar(400)) LIKE @like`,
  { like },
);
line(`  SSL_Test rows matching "${term}": ${testHits.length}`);
for (const t of testHits) line(`    ${t.Test_Number}  dut=${t.dut}  descr=${t.descr}`);

const { rows: phaseHits } = await mesQuery(
  `SELECT TOP (20) Phase_ID, COUNT(*) AS n, MAX(Phase_Date) AS newest
   FROM dbo.SSL_ResPhase
   WHERE Phase_ID LIKE @like
   GROUP BY Phase_ID
   ORDER BY MAX(Phase_Date) DESC`,
  { like },
);
line(`  SSL_ResPhase.Phase_ID matching "${term}": ${phaseHits.length}`);
for (const h of phaseHits) line(`    ${h.Phase_ID}  (${h.n} rows, last ${plantClock(h.newest)})`);

/* 4 ── What product is the program THIS PLATFORM is configured for? */
rule(`4. WHAT PRODUCT IS THE CONFIGURED PROGRAM (${cfg.testNumber}) FOR?`);
const { rows: cfgTest } = await mesQuery(
  `SELECT TOP (5) Test_Number,
          CAST(DUT_Type AS nvarchar(200))    AS dut,
          CAST(Description AS nvarchar(400)) AS descr
   FROM dbo.SSL_Test WHERE Test_Number = @tn`,
  { tn: cfg.testNumber },
);
if (!cfgTest.length) line(`  no SSL_Test row for ${cfg.testNumber}`);
for (const t of cfgTest) {
  line(`  Test_Number  ${t.Test_Number}`);
  line(`  DUT_Type     ${t.dut}`);
  line(`  Description  ${t.descr}`);
}

/* 5 ── The exact phases ST100 has written in the last hour, verbatim. */
rule(`5. EVERY PHASE ST${cfg.stationNumber} HAS WRITTEN IN THE LAST 60 MINUTES (verbatim)`);
const { rows: st } = await mesQuery(
  `SELECT TOP (60) Phase_Date, SN, Phase_ID, Phase_Result, Operator_ID
   FROM dbo.SSL_ResPhase
   WHERE Station_Number = @station AND Phase_Date >= @since
   ORDER BY Phase_Date DESC`,
  { station: cfg.stationNumber, since: since60 },
);
for (const r of st) {
  line(
    `  ${plantClock(r.Phase_Date)}  ${String(r.SN ?? "—").padEnd(15)} ` +
      `${String(r.Phase_ID ?? "—").padEnd(38)} ${String(r.Phase_Result ?? "—").padEnd(7)} op=${r.Operator_ID ?? "—"}`,
  );
}
line(`  → ${st.length} phase row(s) at ST${cfg.stationNumber} in the last hour`);

process.exit(0);
