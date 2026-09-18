#!/usr/bin/env node
/**
 * Diagnostic: how does SSL_ResPhase.Operator_ID join to SSL_Users?
 *
 * Answers about the line keep coming back with "the operator's name could not
 * be retrieved", which reads like a system fault to a plant director when it is
 * really a wrong join. This prints the candidate keys side by side so the
 * mapping is chosen from evidence rather than from the column names.
 *
 *   npx tsx tools/mes-operator-probe.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env"),
});

const { mesQuery, plantClock } = await import("../backend/src/services/mesSql.ts");

const recent = await mesQuery(
  `SELECT TOP (8) Station_Number, Operator_ID, SN, Phase_Date
   FROM dbo.SSL_ResPhase ORDER BY Phase_Date DESC, ID DESC`,
);
console.log("recent Operator_ID values written by the line:");
for (const r of recent.rows) {
  console.log(
    `  ST${r.Station_Number}  operator=${JSON.stringify(r.Operator_ID)}  ${plantClock(r.Phase_Date)}`,
  );
}

const users = await mesQuery(
  `SELECT TOP (12) UserID, UserName, Name, Surname, Dept FROM dbo.SSL_Users
   ORDER BY UserID`,
);
console.log("\nSSL_Users sample:");
for (const u of users.rows) {
  console.log(
    `  UserID=${JSON.stringify(u.UserID)}  UserName=${JSON.stringify(u.UserName)}  ` +
      `Name=${JSON.stringify(u.Name)} Surname=${JSON.stringify(u.Surname)} Dept=${JSON.stringify(u.Dept)}`,
  );
}

const { rows: counts } = await mesQuery(
  `SELECT COUNT(*) AS total FROM dbo.SSL_Users`,
);
console.log(`\nSSL_Users row count: ${counts[0]?.total}`);

// Test each candidate join against the operator IDs the line is actually using.
const ids = [...new Set(recent.rows.map((r) => String(r.Operator_ID ?? "").trim()))].filter(Boolean);
console.log(`\nresolving live operator ids ${JSON.stringify(ids)}:`);
for (const id of ids) {
  const byName = await mesQuery(
    `SELECT TOP (3) UserID, UserName, Name, Surname FROM dbo.SSL_Users WHERE UserName = @id`,
    { id },
  );
  const byId = await mesQuery(
    `SELECT TOP (3) UserID, UserName, Name, Surname FROM dbo.SSL_Users
     WHERE CAST(UserID AS nvarchar(50)) = @id`,
    { id },
  );
  const fmt = (rs) =>
    rs.length
      ? rs.map((r) => `${r.Name ?? ""} ${r.Surname ?? ""}`.trim() || "(blank name)").join(" / ")
      : "no match";
  console.log(`  ${id}:  UserName → ${fmt(byName.rows)}   |   UserID → ${fmt(byId.rows)}`);
}

process.exit(0);
