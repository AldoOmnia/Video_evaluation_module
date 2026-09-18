#!/usr/bin/env node
/**
 * Which test program owns the phases a station is actually writing?
 *
 * Raw SQL, no language model. Phase_ID prefixes at ST100 (`4900.12000 …`) do not
 * match the configured program's published set (`4900.12001 …`), so this walks
 * SSL_Phase back to the Test_Number that publishes them and names the product
 * from SSL_Test. That turns "unmapped variant" into "this exact axle model".
 *
 *   npx tsx tools/mes-identify-program.mjs
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

const cfg = mesConfig();
const line = (s = "") => console.log(s);
const rule = (t) => line(`\n${"─".repeat(74)}\n${t}\n`);

/* 1 ── Which Test_Number publishes the phases ST100 is writing right now? */
rule("1. WHICH PROGRAM PUBLISHES THE PHASES ST100 IS WRITING?");
const { rows: owners } = await mesQuery(
  `SELECT TOP (20) p.Test_Number,
          CAST(t.DUT_Type AS nvarchar(200))    AS dut,
          CAST(t.Description AS nvarchar(400)) AS descr,
          COUNT(*) AS phases
   FROM dbo.SSL_Phase p
   LEFT JOIN dbo.SSL_Test t ON t.Test_Number = p.Test_Number
   WHERE p.Station_Number = @station AND p.Phase_ID LIKE '4900.12000%'
   GROUP BY p.Test_Number, CAST(t.DUT_Type AS nvarchar(200)), CAST(t.Description AS nvarchar(400))
   ORDER BY COUNT(*) DESC`,
  { station: cfg.stationNumber },
);
if (!owners.length) line("  no SSL_Phase rows publish '4900.12000%' at this station");
for (const o of owners) {
  line(`  Test_Number  ${o.Test_Number}   (${o.phases} phases)`);
  line(`  DUT_Type     ${o.dut}`);
  line(`  Description  ${o.descr}`);
  line();
}

/* 2 ── Every program that publishes phases at ST100, so the variants are visible. */
rule(`2. ALL PROGRAMS PUBLISHING PHASES AT ST${cfg.stationNumber}`);
const { rows: progs } = await mesQuery(
  `SELECT p.Test_Number,
          CAST(t.Description AS nvarchar(400)) AS descr,
          COUNT(*) AS phases,
          MIN(CAST(p.Phase_ID AS nvarchar(200))) AS sample_phase
   FROM dbo.SSL_Phase p
   LEFT JOIN dbo.SSL_Test t ON t.Test_Number = p.Test_Number
   WHERE p.Station_Number = @station
   GROUP BY p.Test_Number, CAST(t.Description AS nvarchar(400))
   ORDER BY p.Test_Number`,
  { station: cfg.stationNumber },
);
line(`  ${"Test_Number".padEnd(20)} ${"description".padEnd(34)} phases`);
for (const p of progs) {
  line(
    `  ${String(p.Test_Number).padEnd(20)} ${String(p.descr ?? "(no SSL_Test row)").slice(0, 34).padEnd(34)} ${String(p.phases).padStart(3)}`,
  );
}

/* 3 ── Where did "425" phases actually run today, and when did they stop? */
rule('3. WHERE DID "425"-NAMED PHASES RUN TODAY?');
const midnight = plantWallClockAsDbDate();
midnight.setUTCHours(0, 0, 0, 0);
const { rows: h425 } = await mesQuery(
  `SELECT Station_Number,
          COUNT(*)          AS phases,
          COUNT(DISTINCT SN) AS units,
          MIN(Phase_Date)    AS first_at,
          MAX(Phase_Date)    AS last_at
   FROM dbo.SSL_ResPhase
   WHERE Phase_Date >= @since AND Phase_ID LIKE '%425%'
   GROUP BY Station_Number
   ORDER BY MAX(Phase_Date) DESC`,
  { since: midnight },
);
if (!h425.length) line("  no phase with '425' in its name has run at all today");
for (const r of h425) {
  line(
    `  ST${String(r.Station_Number).padEnd(5)} ${String(r.phases).padStart(3)} phases  ` +
      `${r.units} unit(s)   ${plantClock(r.first_at)} → ${plantClock(r.last_at)}`,
  );
}

/* 4 ── Production_Manager: is it populated at all? Section 1 of the previous
       tool showed no row for any live serial, which would make Model unusable. */
rule("4. IS Production_Manager POPULATED?");
const { rows: pmStats } = await mesQuery(
  `SELECT COUNT(*) AS rows_, COUNT(DISTINCT SN) AS serials FROM dbo.Production_Manager`,
);
line(`  total rows ${pmStats[0]?.rows_}   distinct serials ${pmStats[0]?.serials}`);
const { rows: pmSample } = await mesQuery(
  `SELECT TOP (5) Sequence, OP, SN, CAST(Model AS nvarchar(200)) AS model
   FROM dbo.Production_Manager ORDER BY Sequence DESC`,
);
for (const r of pmSample) {
  line(`  Sequence=${r.Sequence} OP=${r.OP} SN=${r.SN} Model=${r.model}`);
}

/* 5 ── So which serials at ST100 belong to which program today? */
rule(`5. ST${cfg.stationNumber} TODAY — PHASE PREFIX PER SERIAL`);
const { rows: perSerial } = await mesQuery(
  `SELECT SN,
          COUNT(*) AS phases,
          MIN(Phase_Date) AS first_at,
          MAX(Phase_Date) AS last_at,
          MAX(CASE WHEN Phase_ID LIKE '4900.12001%' THEN 1 ELSE 0 END) AS has_12001,
          MAX(CASE WHEN Phase_ID LIKE '4900.12000%' THEN 1 ELSE 0 END) AS has_12000,
          MAX(CASE WHEN Phase_ID LIKE '4900.11003%' THEN 1 ELSE 0 END) AS has_11003
   FROM dbo.SSL_ResPhase
   WHERE Station_Number = @station AND Phase_Date >= @since
   GROUP BY SN
   ORDER BY MAX(Phase_Date) DESC`,
  { station: cfg.stationNumber, since: midnight },
);
line(`  ${"serial".padEnd(16)} ph  12001(425?)  12000  11003   window`);
for (const r of perSerial) {
  line(
    `  ${String(r.SN).padEnd(16)} ${String(r.phases).padStart(2)}  ` +
      `${r.has_12001 ? "  YES     " : "   no     "}  ${r.has_12000 ? "YES  " : "no   "}  ` +
      `${r.has_11003 ? "YES  " : "no   "}   ${plantClock(r.first_at)} → ${plantClock(r.last_at)}`,
  );
}

process.exit(0);
