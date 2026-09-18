"""Reshim classification playbook.

Rules mirror the memory playbook `fargo-reshim-analysis`:

  Family (heuristic from Internal_Part_Number — NEEDS QC CONFIRMATION):
      X900.SW*         → Family 425   (spec 0.53 – 0.69 mm)
      X900.QT/LW/RT*   → Family 600   (spec 0.35 – 0.46 mm)

  Backlash_Status:
      OK         : Spec_Low ≤ Backlash_avg_mm ≤ Spec_High
      BAD        : 0 < deviation ≤ 0.15 mm on either side
      BAD_HEAVY  : deviation > 0.15 mm

  Bucket:
      1_<0.5     : Backlash_avg_mm < 0.5
      2_0.5-0.8  : 0.5 ≤ Backlash_avg_mm < 0.8
      3_>0.8     : ≥ 0.8

  Exclusions:
      - SN in ('0000','28042026') and other non-standard test/setup entries
      - Zero-shim rows (Pinion=Brake=Diff=0)
      - Pre-launch variants with 100% BAD (flag but don't include in yield)
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import date, datetime
from typing import Iterable

from .pull import MeasurementRow


SPEC_BY_FAMILY: dict[str, tuple[float, float]] = {
    "425": (0.53, 0.69),
    "600": (0.35, 0.46),
    "600-905": (0.381, 0.503),
}


def infer_family(internal_pn: str) -> str:
    if not internal_pn:
        return "UNKNOWN"
    parts = internal_pn.split(".")
    if len(parts) < 2:
        return "UNKNOWN"
    variant = parts[1]
    if variant.startswith("SW"):
        return "425"
    if variant in ("QTF", "QTR", "LWF", "LWR", "RTF", "RTR"):
        return "600"
    return "UNKNOWN"


def classify_backlash(family: str, backlash_mm: float) -> str:
    spec = SPEC_BY_FAMILY.get(family)
    if spec is None:
        return "UNKNOWN_FAMILY"
    lo, hi = spec
    if lo <= backlash_mm <= hi:
        return "OK"
    dev = min(abs(backlash_mm - lo), abs(backlash_mm - hi))
    return "BAD" if dev <= 0.15 else "BAD_HEAVY"


def bucket_backlash(b: float) -> str:
    if b < 0.5:
        return "1_<0.5"
    if b < 0.8:
        return "2_0.5-0.8"
    return "3_>0.8"


@dataclass
class ClassifiedRow:
    sn: str
    internal_part_number: str
    family: str
    pinion_mm: float | None
    brake_mm: float | None
    differential_mm: float | None
    backlash_avg_mm: float | None
    spec_low: float | None
    spec_high: float | None
    backlash_status: str
    bucket: str
    reshim_date: datetime
    excluded_reason: str = ""

    def as_dict(self) -> dict:
        d = asdict(self)
        d["reshim_date"] = self.reshim_date.isoformat() if self.reshim_date else ""
        return d


NON_STANDARD_SNS = {"0000", "28042026"}


def classify_rows(
    measurements: Iterable[MeasurementRow],
    testno_lookup: dict[str, str],
) -> list[ClassifiedRow]:
    out: list[ClassifiedRow] = []
    for m in measurements:
        ipn = testno_lookup.get(m.sn, "")
        fam = infer_family(ipn)
        spec = SPEC_BY_FAMILY.get(fam, (None, None))

        excluded = ""
        if m.sn in NON_STANDARD_SNS:
            excluded = "non_standard_sn"
        elif m.is_zero_shim():
            excluded = "zero_shim"
        elif m.backlash_avg_mm is None:
            excluded = "no_backlash"

        status = (
            "EXCLUDED" if excluded
            else classify_backlash(fam, m.backlash_avg_mm)  # type: ignore[arg-type]
        )
        bucket = "" if excluded else bucket_backlash(m.backlash_avg_mm)  # type: ignore[arg-type]

        out.append(ClassifiedRow(
            sn=m.sn,
            internal_part_number=ipn,
            family=fam,
            pinion_mm=m.pinion_mm,
            brake_mm=m.brake_mm,
            differential_mm=m.differential_mm,
            backlash_avg_mm=m.backlash_avg_mm,
            spec_low=spec[0],
            spec_high=spec[1],
            backlash_status=status,
            bucket=bucket,
            reshim_date=m.reshim_date,
            excluded_reason=excluded,
        ))
    return out


@dataclass
class ClassifiedSummary:
    total: int
    excluded: int
    ok: int
    bad: int
    bad_heavy: int
    unknown_family: int
    by_family: dict[str, dict[str, int]]
    by_variant: dict[str, dict[str, int]]
    high_bad_variants: list[tuple[str, int, float]]   # (variant, n, bad_pct)

    def as_dict(self) -> dict:
        return {
            **{k: v for k, v in self.__dict__.items() if k not in ("by_family", "by_variant", "high_bad_variants")},
            "by_family": self.by_family,
            "by_variant": self.by_variant,
            "high_bad_variants": [
                {"variant": v, "n": n, "bad_pct": round(p, 1)} for v, n, p in self.high_bad_variants
            ],
        }


def summarize(rows: list[ClassifiedRow], high_bad_threshold: float = 0.30) -> ClassifiedSummary:
    included = [r for r in rows if not r.excluded_reason]
    by_family: dict[str, dict[str, int]] = {}
    by_variant: dict[str, dict[str, int]] = {}
    for r in included:
        by_family.setdefault(r.family, {}).setdefault(r.backlash_status, 0)
        by_family[r.family][r.backlash_status] += 1
        by_variant.setdefault(r.internal_part_number, {}).setdefault(r.backlash_status, 0)
        by_variant[r.internal_part_number][r.backlash_status] += 1

    high_bad: list[tuple[str, int, float]] = []
    for variant, cnt in by_variant.items():
        total = sum(cnt.values())
        if total == 0:
            continue
        bad_pct = 100 * (cnt.get("BAD", 0) + cnt.get("BAD_HEAVY", 0)) / total
        if bad_pct >= high_bad_threshold * 100:
            high_bad.append((variant, total, bad_pct))
    high_bad.sort(key=lambda x: (-x[2], -x[1]))

    return ClassifiedSummary(
        total=len(rows),
        excluded=sum(1 for r in rows if r.excluded_reason),
        ok=sum(1 for r in included if r.backlash_status == "OK"),
        bad=sum(1 for r in included if r.backlash_status == "BAD"),
        bad_heavy=sum(1 for r in included if r.backlash_status == "BAD_HEAVY"),
        unknown_family=sum(1 for r in included if r.backlash_status == "UNKNOWN_FAMILY"),
        by_family=by_family,
        by_variant=by_variant,
        high_bad_variants=high_bad,
    )
