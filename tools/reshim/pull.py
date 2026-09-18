"""Pull same-day reshim measurements from SSL04_FARGO.

Two datasets per run:
  1. Measurements — one row per SN with the 7 canonical columns pivoted from
     SSL_ResPhase1 ([LPIN] Pinion / [LBRK] Brake / [LDIFF] Diff / Backlash 2)
  2. Test-number lookup — SN → Internal_Part_Number, latest per (SN, Station)

Both keyed by Phase_Date within the target plant-local day.

The MES stores Phase_Date as a naive SQL datetime in plant wall time
(America/Chicago). We convert to UTC before comparing with a plant-day window.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable

import pyodbc

from .config import Config, plant_day_bounds


MEAS_SQL = """
WITH src AS (
    SELECT
        p1.SN, p1.Description_Acq, p1.Value_Acq, p.Phase_Date, p1.Station_Number
    FROM SSL_ResPhase1 p1
    INNER JOIN SSL_ResPhase p
      ON p.SN = p1.SN AND p.Phase_ID = p1.Phase_ID
     AND p.Phase_Number = p1.Phase_Number AND p.Station_Number = p1.Station_Number
    WHERE p.Phase_Date >= ? AND p.Phase_Date < ?
      AND p1.Station_Number IN (130, 135)
      AND p1.Description_Acq IN (
          '[LPIN] Pinion Value:',
          '[LBRK] Brake Value:',
          '[LDIFF] Diff. Value:',
          'Backlash 2 [mm]'
      )
      AND p1.SN NOT IN ('0000','28042026')
),
ranked AS (
    SELECT SN, Description_Acq, Value_Acq, Phase_Date,
           ROW_NUMBER() OVER (PARTITION BY SN, Description_Acq ORDER BY Phase_Date DESC) AS rn
    FROM src
)
SELECT SN,
    MAX(CASE WHEN Description_Acq = '[LPIN] Pinion Value:' AND rn = 1 THEN Value_Acq END) AS Pinion_mm,
    MAX(CASE WHEN Description_Acq = '[LBRK] Brake Value:'  AND rn = 1 THEN Value_Acq END) AS Brake_mm,
    MAX(CASE WHEN Description_Acq = '[LDIFF] Diff. Value:' AND rn = 1 THEN Value_Acq END) AS Differential_mm,
    MAX(CASE WHEN Description_Acq = 'Backlash 2 [mm]'      AND rn = 1 THEN Value_Acq END) AS Backlash_avg_mm,
    MAX(CASE WHEN rn = 1 THEN Phase_Date END) AS Reshim_Date
FROM ranked
GROUP BY SN
HAVING MAX(CASE WHEN Description_Acq = 'Backlash 2 [mm]' AND rn = 1 THEN Value_Acq END) IS NOT NULL
ORDER BY Reshim_Date DESC
"""

TESTNO_SQL = """
SELECT SN, Test_Number, MAX(Test_Date) AS last_test
FROM SSL_Res
WHERE Test_Date >= ? AND Test_Date < ?
  AND Station_Number IN (130, 135)
GROUP BY SN, Test_Number
ORDER BY last_test DESC
"""


@dataclass
class MeasurementRow:
    sn: str
    pinion_mm: float | None
    brake_mm: float | None
    differential_mm: float | None
    backlash_avg_mm: float | None
    reshim_date: datetime  # plant-local wall time as naive datetime

    def is_zero_shim(self) -> bool:
        vals = [self.pinion_mm, self.brake_mm, self.differential_mm]
        return all(v is not None and v == 0 for v in vals)


def _assert_readonly(sql: str) -> None:
    """Deny-by-default gate mirroring the TS backend's mesSql.ts guard."""
    upper = sql.upper()
    for verb in ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "MERGE", "CREATE", "GRANT", "REVOKE"):
        # Word-boundary check to avoid false positives in column names
        import re
        if re.search(rf"\b{verb}\b", upper):
            raise RuntimeError(f"pull.py refuses to run non-read-only SQL (matched {verb!r})")


def _open_conn(cfg: Config) -> pyodbc.Connection:
    conn = pyodbc.connect(cfg.mes.odbc_connstr(), timeout=15)
    # READ UNCOMMITTED so we never take locks that could block plant writes
    cur = conn.cursor()
    cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
    cur.close()
    return conn


def fetch_measurements(cfg: Config, day: date) -> list[MeasurementRow]:
    _assert_readonly(MEAS_SQL)
    start, end = plant_day_bounds(cfg, day)
    # Phase_Date is stored naive in plant wall time — pass naive bounds
    lo = start.replace(tzinfo=None)
    hi = end.replace(tzinfo=None)
    out: list[MeasurementRow] = []
    with _open_conn(cfg) as cx:
        cur = cx.cursor()
        cur.execute(MEAS_SQL, lo, hi)
        for row in cur:
            out.append(MeasurementRow(
                sn=row.SN,
                pinion_mm=float(row.Pinion_mm) if row.Pinion_mm is not None else None,
                brake_mm=float(row.Brake_mm) if row.Brake_mm is not None else None,
                differential_mm=float(row.Differential_mm) if row.Differential_mm is not None else None,
                backlash_avg_mm=float(row.Backlash_avg_mm) if row.Backlash_avg_mm is not None else None,
                reshim_date=row.Reshim_Date,
            ))
    return out


def fetch_testno_lookup(cfg: Config, day: date) -> dict[str, str]:
    """SN -> Internal_Part_Number (Test_Number), most recent per SN."""
    _assert_readonly(TESTNO_SQL)
    start, end = plant_day_bounds(cfg, day)
    lo, hi = start.replace(tzinfo=None), end.replace(tzinfo=None)
    lookup: dict[str, str] = {}
    with _open_conn(cfg) as cx:
        cur = cx.cursor()
        cur.execute(TESTNO_SQL, lo, hi)
        for row in cur:
            if row.SN not in lookup:  # first row is most recent (ORDER BY last_test DESC)
                lookup[row.SN] = row.Test_Number
    return lookup
