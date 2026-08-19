#!/usr/bin/env node
/**
 * Regression cover for the read-only SQL guard.
 *
 * The natural-language path lets a model compose SQL against a live production
 * MES, and Comer's credential is a sysadmin login today — so "the login is
 * read-only" is not the defence. This asserts the guard is, including the cases
 * that look like a SELECT and are not: SELECT … INTO creates a table, comments
 * and string literals hide keywords from a naive scan, and a second statement
 * after a semicolon is the oldest trick there is.
 *
 *   npx tsx tools/test-sql-guard.mjs
 */
import { assertReadOnly, UnsafeQueryError } from "../backend/src/services/mesSql.ts";

const ALLOW = [
  ["plain select", "SELECT TOP (10) SN, Phase_ID FROM dbo.SSL_ResPhase"],
  ["aggregate", "SELECT Station_Number, COUNT(*) AS n FROM dbo.SSL_ResPhase GROUP BY Station_Number"],
  ["join", "SELECT r.SN, u.Name FROM dbo.SSL_ResPhase r JOIN dbo.SSL_Users u ON u.UserName = r.Operator_ID"],
  ["CTE", "WITH recent AS (SELECT TOP (5) * FROM dbo.SSL_ResPhase ORDER BY Phase_Date DESC) SELECT * FROM recent"],
  ["trailing semicolon", "SELECT 1 FROM dbo.SSL_Test;"],
  ["bracketed cols", "SELECT [min], [max] FROM dbo.SSL_ResPhase1"],
  ["param binding", "SELECT * FROM dbo.SSL_ResPhase WHERE Station_Number = @station"],
];

const DENY = [
  ["update", "UPDATE dbo.SSL_ResPhase SET Phase_Result = 'OK'"],
  ["delete", "DELETE FROM dbo.SSL_ResPhase"],
  ["drop", "DROP TABLE dbo.SSL_ResPhase"],
  ["truncate", "TRUNCATE TABLE dbo.SSL_ResPhase"],
  ["select into (a write that starts with SELECT)", "SELECT * INTO dbo.copy FROM dbo.SSL_ResPhase"],
  ["stacked statement", "SELECT 1; DROP TABLE dbo.SSL_Users"],
  ["stacked with comment", "SELECT 1; -- ok\nDELETE FROM dbo.SSL_Users"],
  ["exec", "EXEC sp_who"],
  ["exec after select", "SELECT 1; EXEC xp_cmdshell 'dir'"],
  ["stored proc", "SELECT * FROM sp_helpdb"],
  ["shutdown", "SHUTDOWN"],
  ["waitfor stall", "SELECT 1 WHERE 1=1 WAITFOR DELAY '00:10:00'"],
  ["openrowset", "SELECT * FROM OPENROWSET('SQLNCLI','...','SELECT 1')"],
  ["bulk insert", "BULK INSERT dbo.t FROM 'c:\\x.txt'"],
  ["grant", "GRANT CONTROL TO public"],
  ["set session", "SET IMPLICIT_TRANSACTIONS ON"],
  ["use db", "USE master"],
  ["dbcc", "DBCC CHECKDB"],
  ["transaction", "BEGIN TRANSACTION"],
  ["alter", "ALTER TABLE dbo.SSL_Users ADD x int"],
  ["create proc", "CREATE PROCEDURE evil AS SELECT 1"],
  ["empty", "   "],
  ["not a select", "MERGE dbo.a AS t USING dbo.b AS s ON 1=1"],
];

let pass = 0;
let fail = 0;

for (const [label, q] of ALLOW) {
  try {
    assertReadOnly(q);
    console.log(`ok    ALLOW  ${label}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ALLOW  ${label} → rejected: ${e.message}`);
    fail++;
  }
}

for (const [label, q] of DENY) {
  try {
    assertReadOnly(q);
    console.log(`FAIL  DENY   ${label} → WAS ALLOWED`);
    fail++;
  } catch (e) {
    if (e instanceof UnsafeQueryError) {
      console.log(`ok    DENY   ${label} (${e.message})`);
      pass++;
    } else {
      console.log(`FAIL  DENY   ${label} → wrong error type: ${e}`);
      fail++;
    }
  }
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
