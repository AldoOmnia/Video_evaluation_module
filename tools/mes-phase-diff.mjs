#!/usr/bin/env node
/**
 * Diagnostic: do the Phase_IDs the line actually writes match the Phase_IDs the
 * configured test program publishes?
 *
 * The connector's build guard reports a station as idle when the newest
 * SSL_ResPhase row carries a Phase_ID outside the published SSL_Phase step set,
 * so the assistant never maps another product's phases onto pinion step codes.
 * That guard is correct in principle, but it is only as good as the assumption
 * that the two tables spell Phase_ID identically — and the connector's own env
 * notes flag that as unverified against the live database. If they differ, a
 * running line reports as quiet, which is the worst possible answer to "what is
 * happening right now".
 *
 *   npx tsx tools/mes-phase-diff.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

// Run from the repo root, but the credentials live in backend/.env (the server
// picks them up because it runs with that as its cwd).
dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env"),
});

const {
  mesConfig,
  mesQuery,
  plantClock,
  plantWallClockAsDbDate,
} = await import("../backend/src/services/mesSql.ts");

const cfg = mesConfig();
const since = plantWallClockAsDbDate(new Date(Date.now() - 24 * 3600_000));

const [published, observed] = await Promise.all([
  mesQuery(
    `SELECT Phase_Number, Phase_ID FROM dbo.SSL_Phase
     WHERE Test_Number = @testNumber AND Station_Number = @station
     ORDER BY Phase_Number`,
    { testNumber: cfg.testNumber, station: cfg.stationNumber },
  ),
  mesQuery(
    `SELECT TOP (60) Phase_ID, COUNT(*) AS n, MAX(Phase_Date) AS newest
     FROM dbo.SSL_ResPhase
     WHERE Station_Number = @station AND Phase_Date >= @since
     GROUP BY Phase_ID
     ORDER BY MAX(Phase_Date) DESC`,
    { station: cfg.stationNumber, since },
  ),
]);

const norm = (v) => String(v ?? "").trim().toUpperCase();
const pubSet = new Set(published.rows.map((r) => norm(r.Phase_ID)));

console.log(`station ${cfg.stationNumber} · program ${cfg.testNumber}`);
console.log(`published step set: ${published.rows.length} phases`);
console.log(`observed at the station in the last 24h: ${observed.rows.length} distinct phases\n`);

let matched = 0;
let unmatched = 0;
console.log("OBSERVED (newest first)          match?  count  newest");
for (const r of observed.rows) {
  const hit = pubSet.has(norm(r.Phase_ID));
  hit ? matched++ : unmatched++;
  console.log(
    `  ${String(r.Phase_ID).slice(0, 38).padEnd(38)} ${hit ? "YES   " : "no    "} ${String(r.n).padStart(4)}   ${plantClock(r.newest)}`,
  );
}

console.log(`\n${matched} observed phases are in the published set, ${unmatched} are not.`);

// Near-misses are the tell: identical prefix, different suffix means the two
// tables describe the same operation with different spellings, not a different
// product on the station.
if (unmatched) {
  console.log("\nnear-misses (same leading words, different Phase_ID):");
  const pubList = [...pubSet];
  let found = 0;
  for (const r of observed.rows) {
    const o = norm(r.Phase_ID);
    if (pubSet.has(o)) continue;
    for (const p of pubList) {
      const a = o.replace(/[^A-Z0-9]/g, " ").split(/\s+/).filter(Boolean);
      const b = p.replace(/[^A-Z0-9]/g, " ").split(/\s+/).filter(Boolean);
      const shared = a.filter((w) => b.includes(w) && w.length > 2).length;
      if (shared >= 2) {
        console.log(`  observed  ${o}\n  published ${p}\n            (${shared} shared words)\n`);
        found++;
        break;
      }
    }
  }
  if (!found) console.log("  none — the station really is running a different product.");
}

process.exit(0);
