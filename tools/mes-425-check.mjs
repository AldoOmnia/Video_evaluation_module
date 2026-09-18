#!/usr/bin/env node
/**
 * Is the 425 rear axle procedure running at ST100 right now?
 *
 * Raw SQL, no language model, values printed verbatim so they can be checked
 * against what a person on the floor is looking at.
 *
 *   npx tsx tools/mes-425-check.mjs
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

const nowDb = plantWallClockAsDbDate();
const midnight = new Date(nowDb);
midnight.setUTCHours(0, 0, 0, 0);
line(`plant clock now   ${plantClock(nowDb)}`);
line(`today's midnight  ${plantClock(midnight)}  (filter boundary)`);

/* 1 ── The 425 program's published phase list, verbatim. */
rule(`1. PUBLISHED PHASES OF THE CONFIGURED 425 PROGRAM (${cfg.testNumber}) AT ST${cfg.stationNumber}`);
const { rows: pub } = await mesQuery(
  `SELECT Phase_Number, CAST(Phase_ID AS nvarchar(200)) AS pid
   FROM dbo.SSL_Phase
   WHERE Test_Number = @tn AND Station_Number = @station
   ORDER BY Phase_Number`,
  { tn: cfg.testNumber, station: cfg.stationNumber },
);
for (const r of pub) line(`  ${String(r.Phase_Number).padStart(3)}  ${r.pid}`);
line(`  → ${pub.length} published phases`);

/* 2 ── Is the 4900.12001 prefix exclusive to the 425 program, or shared? */
rule("2. WHICH PROGRAMS PUBLISH THE '4900.12001' PREFIX?");
const { rows: excl } = await mesQuery(
  `SELECT p.Test_Number, CAST(t.Description AS nvarchar(200)) AS descr, COUNT(*) AS n
   FROM dbo.SSL_Phase p
   LEFT JOIN dbo.SSL_Test t ON t.Test_Number = p.Test_Number
   WHERE CAST(p.Phase_ID AS nvarchar(200)) LIKE '4900.12001%'
   GROUP BY p.Test_Number, CAST(t.Description AS nvarchar(200))
   ORDER BY p.Test_Number`,
);
for (const r of excl) line(`  ${String(r.Test_Number).padEnd(20)} ${r.descr ?? "(blank)"}  (${r.n})`);
line(`  → ${excl.length} program(s)`);

/* 3 ── Distinct phase prefixes written at ST100 today, with counts and window.
       Grouping on a CAST expression rather than the raw column: Phase_ID is a
       legacy text column, which SQL Server will not GROUP BY directly. */
rule(`3. PHASE PREFIXES WRITTEN AT ST${cfg.stationNumber} TODAY`);
const { rows: prefixes } = await mesQuery(
  `SELECT LEFT(CAST(Phase_ID AS nvarchar(200)), 10) AS prefix,
          COUNT(*)           AS phases,
          COUNT(DISTINCT SN) AS units,
          MIN(Phase_Date)    AS first_at,
          MAX(Phase_Date)    AS last_at
   FROM dbo.SSL_ResPhase
   WHERE Station_Number = @station AND Phase_Date >= @since
   GROUP BY LEFT(CAST(Phase_ID AS nvarchar(200)), 10)
   ORDER BY MAX(Phase_Date) DESC`,
  { station: cfg.stationNumber, since: midnight },
);
line(`  ${"prefix".padEnd(12)} phases units  window`);
for (const r of prefixes) {
  line(
    `  ${String(r.prefix).padEnd(12)} ${String(r.phases).padStart(6)} ${String(r.units).padStart(5)}  ` +
      `${plantClock(r.first_at)} → ${plantClock(r.last_at)}`,
  );
}
if (!prefixes.length) line("  (no rows — check the date filter)");

/* 4 ── The direct question: has the 425 phase set run at ST100 today at all? */
rule(`4. HAS ANY '4900.12001' (425) PHASE RUN AT ST${cfg.stationNumber} TODAY?`);
const { rows: hit } = await mesQuery(
  `SELECT COUNT(*) AS n, MAX(Phase_Date) AS last_at
   FROM dbo.SSL_ResPhase
   WHERE Station_Number = @station
     AND Phase_Date >= @since
     AND CAST(Phase_ID AS nvarchar(200)) LIKE '4900.12001%'`,
  { station: cfg.stationNumber, since: midnight },
);
line(`  matching rows today: ${hit[0]?.n}   last: ${plantClock(hit[0]?.last_at) ?? "never"}`);

/* And ever, so "not today" is not confused with "not in this database". */
const { rows: ever } = await mesQuery(
  `SELECT COUNT(*) AS n, MAX(Phase_Date) AS last_at
   FROM dbo.SSL_ResPhase
   WHERE Station_Number = @station
     AND CAST(Phase_ID AS nvarchar(200)) LIKE '4900.12001%'`,
  { station: cfg.stationNumber },
);
line(`  matching rows ever:  ${ever[0]?.n}   last: ${plantClock(ever[0]?.last_at) ?? "never"}`);

/* 5 ── And the SWR (small wheel rear) family generally, by phase name. */
rule("5. ANY 'SWR' / 425-NAMED ACTIVITY ACROSS THE WHOLE PLANT TODAY");
const { rows: plant } = await mesQuery(
  `SELECT Station_Number,
          LEFT(CAST(Phase_ID AS nvarchar(200)), 40) AS pid,
          COUNT(*) AS n,
          MAX(Phase_Date) AS last_at
   FROM dbo.SSL_ResPhase
   WHERE Phase_Date >= @since AND CAST(Phase_ID AS nvarchar(200)) LIKE '%425%'
   GROUP BY Station_Number, LEFT(CAST(Phase_ID AS nvarchar(200)), 40)
   ORDER BY MAX(Phase_Date) DESC`,
  { since: midnight },
);
if (!plant.length) line("  none");
for (const r of plant) {
  line(
    `  ST${String(r.Station_Number).padEnd(5)} ${String(r.pid).padEnd(34)} ${String(r.n).padStart(3)}  last ${plantClock(r.last_at)}`,
  );
}

process.exit(0);
