"""Per-photo SN assignment with orphan-neighbor + time-fallback.

Given (a) all photos with timestamps, (b) OCR results per photo, and
(c) DB classified rows with Reshim_Date, produce a mapping of SN → ordered
photo paths (Tag_Image first, then process shots), capped at MAX_IMGS_PER_SN.

Three-stage assignment (v3 logic from the memory playbook):
  1. Photos whose OCR yielded a valid SN → assigned directly to that SN.
  2. Orphan photos (no valid OCR SN) → assigned to the temporally nearest
     OCR anchor within NEIGHBOR_WINDOW_MIN.
  3. For DB SNs still with no photos, cluster remaining orphans by ≤5-min
     gap and assign a full cluster if its median time is within
     TIME_FALLBACK_MIN of the SN's Reshim_Date.
"""
from __future__ import annotations
import bisect
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from .analyze import ClassifiedRow
from .ocr import SnResult, photo_ts


MAX_IMGS_PER_SN = 6
NEIGHBOR_WINDOW_MIN = 15
TIME_FALLBACK_MIN = 10


@dataclass
class PhotoRecord:
    path: Path
    ts: datetime


@dataclass
class SnAssignment:
    sn: str
    photos: list[Path]                # ordered: tag first, then process shots
    match_method: str                 # OCR | NEIGHBOR | TIME_FALLBACK | ""
    n_clusters: int                   # ≥2 means the SN appears in multiple
                                      # temporally-separated photo bursts (rework)


def assign(
    photos: list[PhotoRecord],
    ocr_results: dict[str, Optional[str]],   # filename → SN or None
    rows: list[ClassifiedRow],
) -> tuple[dict[str, SnAssignment], list[Path], list[Path]]:
    """
    Returns:
      (sn_to_assignment, unassigned_photos, photos_of_unknown_sn)
      - unassigned_photos: photos with no OCR AND no neighbor within window
      - photos_of_unknown_sn: photos whose OCR SN wasn't in the DB row set
    """
    valid_sns = {r.sn for r in rows}
    reshim_by_sn = {r.sn: r.reshim_date for r in rows if r.reshim_date is not None}
    photos_sorted = sorted(photos, key=lambda p: p.ts)

    # Stage 1: direct OCR assignments (build anchor list)
    anchors: list[tuple[datetime, Path, str]] = []
    photo_sn: dict[Path, str] = {}
    photo_source: dict[Path, str] = {}
    tag_of: dict[str, Path] = {}
    photos_of_unknown: list[Path] = []
    for pr in photos_sorted:
        sn = ocr_results.get(pr.path.name)
        if not sn:
            continue
        if sn not in valid_sns:
            photos_of_unknown.append(pr.path)
            continue
        anchors.append((pr.ts, pr.path, sn))
        photo_sn[pr.path] = sn
        photo_source[pr.path] = "OCR"
        tag_of.setdefault(sn, pr.path)

    # Stage 2: orphan → nearest anchor within ±NEIGHBOR_WINDOW_MIN
    anchor_times = [a[0] for a in anchors]
    orphans = [pr for pr in photos_sorted if pr.path not in photo_sn and pr.path not in photos_of_unknown]
    for pr in orphans:
        idx = bisect.bisect_left(anchor_times, pr.ts)
        best: Optional[tuple[float, str]] = None
        for cand_idx in (idx - 1, idx):
            if 0 <= cand_idx < len(anchors):
                ats, _, asn = anchors[cand_idx]
                delta = abs((pr.ts - ats).total_seconds())
                if delta <= NEIGHBOR_WINDOW_MIN * 60:
                    if best is None or delta < best[0]:
                        best = (delta, asn)
        if best:
            photo_sn[pr.path] = best[1]
            photo_source[pr.path] = "NEIGHBOR"

    # Stage 3: time fallback for DB SNs still unassigned
    unassigned_orphans = [pr for pr in orphans if pr.path not in photo_sn]
    unassigned_orphans.sort(key=lambda p: p.ts)
    orphan_clusters: list[list[PhotoRecord]] = []
    if unassigned_orphans:
        cur = [unassigned_orphans[0]]
        for pr in unassigned_orphans[1:]:
            if (pr.ts - cur[-1].ts).total_seconds() / 60.0 <= 5.0:
                cur.append(pr)
            else:
                orphan_clusters.append(cur)
                cur = [pr]
        orphan_clusters.append(cur)

    def cluster_median(c: list[PhotoRecord]) -> datetime:
        tss = sorted(x.ts for x in c)
        return tss[len(tss) // 2]

    sns_currently = set(photo_sn.values())
    still_needing = [(r.sn, r.reshim_date) for r in rows if r.reshim_date and r.sn not in sns_currently]
    used_clusters: set[int] = set()
    for sn, rd in still_needing:
        best_ci: Optional[tuple[float, int]] = None
        for ci, cluster in enumerate(orphan_clusters):
            if ci in used_clusters:
                continue
            delta = abs((cluster_median(cluster) - rd).total_seconds())
            if delta <= TIME_FALLBACK_MIN * 60:
                if best_ci is None or delta < best_ci[0]:
                    best_ci = (delta, ci)
        if best_ci:
            _, ci = best_ci
            used_clusters.add(ci)
            for pr in orphan_clusters[ci]:
                photo_sn[pr.path] = sn
                photo_source[pr.path] = "TIME_FALLBACK"
            tag_of.setdefault(sn, orphan_clusters[ci][0].path)

    # Group + order per SN (tag first, then process in chronological order)
    grouped: dict[str, list[tuple[datetime, Path, bool]]] = defaultdict(list)
    for pr in photos_sorted:
        sn = photo_sn.get(pr.path)
        if not sn:
            continue
        is_tag = tag_of.get(sn) == pr.path
        grouped[sn].append((pr.ts, pr.path, is_tag))

    assignments: dict[str, SnAssignment] = {}
    for sn, entries in grouped.items():
        # Detect rework: multiple temporally-separated bursts (gap > 30 min)
        entries.sort()
        n_clusters = 1
        for i in range(1, len(entries)):
            if (entries[i][0] - entries[i - 1][0]).total_seconds() / 60.0 > 30.0:
                n_clusters += 1
        tags = [p for _, p, is_tag in entries if is_tag]
        procs = [p for _, p, is_tag in entries if not is_tag]
        ordered = (tags[:1] + procs + tags[1:])[:MAX_IMGS_PER_SN]
        methods = {photo_source[p] for p in ordered if p in photo_source}
        # Prefer OCR label; fall back
        method = "OCR" if "OCR" in methods else ("NEIGHBOR" if "NEIGHBOR" in methods else "TIME_FALLBACK")
        assignments[sn] = SnAssignment(sn=sn, photos=ordered, match_method=method, n_clusters=n_clusters)

    unassigned = [pr.path for pr in unassigned_orphans if pr.path not in photo_sn]
    return assignments, unassigned, photos_of_unknown
