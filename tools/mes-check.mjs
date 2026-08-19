#!/usr/bin/env node
/**
 * Verify the MES database connection — no server, no LLM, no API keys.
 *
 * This is the first thing to run on site, and the first thing to run when the
 * line card shows demo data. It isolates the question "can this machine read the
 * MES?" from everything else in the platform, so a network or credential problem
 * cannot be mistaken for a model or UI problem.
 *
 *   npm run mes:check
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env"),
});

const {
  PLANT_TZ,
  fetchStationSnapshot,
  mesConfig,
  mesConfigured,
  mesHealth,
  mesQuery,
  plantClock,
  plantWallClockAsDbDate,
} = await import("../backend/src/services/mesSql.ts");

const cfg = mesConfig();

if (!mesConfigured()) {
  console.error("✗ not configured\n");
  console.error("  Set these in backend/.env:");
  console.error("    MES_MSSQL_HOST=WARKFSQL002");
  console.error("    MES_MSSQL_PORT=1433");
  console.error("    MES_MSSQL_DATABASE=SSL04_FARGO");
  console.error("    MES_MSSQL_USER=<readonly-login>");
  console.error("    MES_MSSQL_PASSWORD=<password>");
  console.error("    MES_STATION_NUMBER=100");
  process.exit(2);
}

console.log(`connecting to ${cfg.database}@${cfg.host}:${cfg.port} as ${cfg.user} …`);

const health = await mesHealth();
if (!health.connected) {
  console.error(`\n✗ could not connect: ${health.error}\n`);
  console.error("  On the plant LAN WARKFSQL002 resolves directly. Off-site you need");
  console.error("  the Cisco VPN, or the host will not resolve at all.");
  process.exit(1);
}

console.log(`\n✓ connected`);
console.log(`  plant timezone     ${PLANT_TZ}`);
console.log(`  plant local time   ${plantClock(plantWallClockAsDbDate())}`);
console.log(`  newest phase       ${health.newestPhaseAt}  (${health.newestPhaseAge} ago)`);

// Plant-wide activity is the clearest signal that this is live data and not a
// stale cache: a real shift lights up several stations at once.
const since = plantWallClockAsDbDate(new Date(Date.now() - 15 * 60_000));
const { rows: active } = await mesQuery(
  `SELECT TOP (30) Station_Number, COUNT(*) AS phases, MAX(Phase_Date) AS newest
   FROM dbo.SSL_ResPhase
   WHERE Phase_Date >= @since
   GROUP BY Station_Number
   ORDER BY MAX(Phase_Date) DESC`,
  { since },
);

console.log(`\nstations active in the last 15 minutes: ${active.length}`);
for (const r of active) {
  console.log(
    `  ST${String(r.Station_Number).padEnd(5)} ${String(r.phases).padStart(3)} phases   last ${plantClock(r.newest)}`,
  );
}

const snap = await fetchStationSnapshot();
console.log(`\ndefault station ST${cfg.stationNumber}:`);
if (!snap) {
  console.log("  no snapshot available");
} else {
  console.log(`  working now       ${snap.session_active ? "yes" : "no"}`);
  console.log(`  phase             ${snap.current_phase_id ?? "—"}`);
  console.log(`  serial            ${snap.serial_number ?? "—"}`);
  console.log(`  operator badge    ${snap.technician_id ?? "—"}`);
  console.log(`  last activity     ${snap.last_phase_local_time} (${snap.last_phase_age} ago)`);
  if (!snap.program_mapped) {
    const product = snap.tracked_program_product;
    console.log(
      `  tracked program   ${cfg.testNumber}${product ? ` — ${product}` : ""}`,
    );
    console.log(
      `  note              this station is building a DIFFERENT model than the\n` +
        `                    tracked program, so step numbering is withheld. The\n` +
        `                    phase, serial and time above are live and correct.`,
    );
  }
}

console.log("\nready — natural-language questions will hit this database.");
process.exit(0);
