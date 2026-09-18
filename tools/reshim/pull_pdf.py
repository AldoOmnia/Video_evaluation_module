"""Alternative data source: UNICOMM Test Report PDFs.

Off-network fallback for when the plant MSSQL isn't reachable. Comer exports
per-SN PDFs from the MES; we parse them for the same 7-column schema the
live pull produces from `SSL_ResPhase1`.

One PDF = one SN. The parser:
  1. Reads the header (SN, Part Number, overall status).
  2. Walks every revision block and extracts the LATEST occurrence of each
     of the four measurement rows: `[LPIN] Pinion Value:`, `[LBRK] Brake Value:`,
     `[LDIFF] Diff. Value:`, `Backlash 2 [mm]`. Latest = last appearance in
     the file, since revisions are printed in chronological order.
  3. Picks the Reshim_Date as the highest-numbered revision's timestamp
     (final attempt) — matches the "latest per SN" semantics of the live SQL
     query.

Values use European decimal comma (`0,64`) — normalized to float.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import pdfplumber

from .pull import MeasurementRow


HEADER_SN_RE   = re.compile(r"SERIAL NUMBER\s+(PCMRS\d+)")
HEADER_PN_RE   = re.compile(r"PART NUMBER\s+(X\d+\.[A-Z]+\.\d+\.[A-Z0-9]+)")
STATUS_RE      = re.compile(r"SERIAL NUMBER STATUS[\s:]+(\w+)")
# The "AM TIME HH:MM:SS" segment gets extracted as `AMTIME`, `ATMIME`, and
# other garbled variants across PDFs — probably a spacing artifact in the
# source. Loose match: revision + date, then grab the LAST HH:MM:SS on the
# same line (which is the operational TIME field, not the print-timestamp).
REVISION_RE = re.compile(
    r"REVISION\s*(\d+)\s+PCMRS\d+-\d+\s+(\d{1,2}/\d{1,2}/\d{4})[^\n]*"
)
TIME_RE = re.compile(r"(\d{2}:\d{2}:\d{2})")
# Description lines look like: "<label> <min> <max> <value> <result>"
# Numbers use European comma-decimal (0,64). Result is OK or NOT OK.
VALUE_LINE_RE = re.compile(
    r"^(?P<label>[\w\[\].: \-]+?)\s+"
    r"(?P<min>-?[\d,.]+)\s+"
    r"(?P<max>-?[\d,.]+)\s+"
    r"(?P<value>-?[\d,.]+)\s+"
    r"(?P<result>OK|NOT OK)\s*$"
)

MEASUREMENT_LABELS = {
    "pinion":       "[LPIN] Pinion Value:",
    "brake":        "[LBRK] Brake Value:",
    "differential": "[LDIFF] Diff. Value:",
    "backlash":     "Backlash 2 [mm]",
}


@dataclass
class PdfExtract:
    sn: str
    part_number: str
    overall_status: str          # OK | NOT OK | RUNNING | MISSING
    pinion_mm: Optional[float]
    brake_mm: Optional[float]
    differential_mm: Optional[float]
    backlash_avg_mm: Optional[float]
    reshim_date: Optional[datetime]
    n_revisions: int
    source_path: Path


def _to_float(raw: str) -> Optional[float]:
    if raw is None:
        return None
    s = raw.strip().replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _extract_all_values(text: str, label_prefix: str) -> list[float]:
    """Return every value read for lines starting with the given label."""
    vals: list[float] = []
    prefix = label_prefix.strip()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith(prefix):
            continue
        m = VALUE_LINE_RE.match(stripped)
        if not m:
            continue
        v = _to_float(m.group("value"))
        if v is not None:
            vals.append(v)
    return vals


def _parse_revisions(text: str) -> list[tuple[int, datetime]]:
    out: list[tuple[int, datetime]] = []
    for m in REVISION_RE.finditer(text):
        rev = int(m.group(1))
        date_s = m.group(2)
        try:
            d = datetime.strptime(date_s, "%m/%d/%Y")
        except ValueError:
            continue
        # Take the LAST HH:MM:SS on the revision line (the operational TIME
        # field, not the printed-at-timestamp). Fall back to midnight if
        # no time is present at all.
        times = TIME_RE.findall(m.group(0))
        if times:
            try:
                t = datetime.strptime(times[-1], "%H:%M:%S").time()
                d = datetime.combine(d.date(), t)
            except ValueError:
                pass
        out.append((rev, d))
    return out


def parse_pdf(path: Path) -> Optional[PdfExtract]:
    with pdfplumber.open(path) as pdf:
        text = "\n".join((p.extract_text() or "") for p in pdf.pages)

    m_sn = HEADER_SN_RE.search(text)
    m_pn = HEADER_PN_RE.search(text)
    if not m_sn:
        return None
    sn = m_sn.group(1)
    pn = m_pn.group(1) if m_pn else ""
    m_status = STATUS_RE.search(text)
    status = m_status.group(1) if m_status else ""

    pin_vals = _extract_all_values(text, MEASUREMENT_LABELS["pinion"])
    brk_vals = _extract_all_values(text, MEASUREMENT_LABELS["brake"])
    diff_vals = _extract_all_values(text, MEASUREMENT_LABELS["differential"])
    bl_vals = _extract_all_values(text, MEASUREMENT_LABELS["backlash"])

    revisions = _parse_revisions(text)
    reshim_date = max((d for _, d in revisions), default=None)

    return PdfExtract(
        sn=sn,
        part_number=pn,
        overall_status=status,
        pinion_mm=pin_vals[-1] if pin_vals else None,
        brake_mm=brk_vals[-1] if brk_vals else None,
        differential_mm=diff_vals[-1] if diff_vals else None,
        backlash_avg_mm=bl_vals[-1] if bl_vals else None,
        reshim_date=reshim_date,
        n_revisions=len(revisions),
        source_path=path,
    )


def load_folder(folder: Path) -> tuple[list[MeasurementRow], dict[str, str], list[Path]]:
    """Parse every PDF in `folder`. Returns (measurements, testno_lookup, skipped_paths)."""
    measurements: list[MeasurementRow] = []
    testno: dict[str, str] = {}
    skipped: list[Path] = []
    for pdf_path in sorted(folder.glob("*.pdf")):
        try:
            ext = parse_pdf(pdf_path)
        except Exception:
            skipped.append(pdf_path)
            continue
        if ext is None:
            skipped.append(pdf_path)
            continue
        if ext.reshim_date is None or ext.backlash_avg_mm is None:
            skipped.append(pdf_path)
            continue
        measurements.append(MeasurementRow(
            sn=ext.sn,
            pinion_mm=ext.pinion_mm,
            brake_mm=ext.brake_mm,
            differential_mm=ext.differential_mm,
            backlash_avg_mm=ext.backlash_avg_mm,
            reshim_date=ext.reshim_date,
        ))
        if ext.part_number:
            testno[ext.sn] = ext.part_number
    return measurements, testno, skipped
