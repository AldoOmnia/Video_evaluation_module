"""SN extraction from operator photos using Claude Vision.

Cross-platform (works anywhere the Anthropic SDK works). Uses claude
vision API on a downscaled JPEG of each HEIC/JPG photo, extracts SN string
matching the Comer pattern (PCMRS0700\\d{3}), and validates against the DB
SN list.

For local dev, a macOS `ocrmac` fallback is used if `ANTHROPIC_API_KEY` isn't
set — same interface, different backend.
"""
from __future__ import annotations
import base64
import io
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image, ExifTags
try:
    import pillow_heif  # type: ignore
    pillow_heif.register_heif_opener()
except Exception:
    pass

from anthropic import Anthropic

from .config import Config


RAW_SN_RE = re.compile(r"(?i)PCMRS[\s_\-]*0?[\s_\-]*7[\s_\-]*0[\s_\-]*0[\s_\-]*(\d{3,5})")

OCR_LONGEST_SIDE = 1600

CLAUDE_PROMPT = (
    "This is a photo taken by an assembly operator at a manufacturing station. "
    "Find any Comer Industries serial number written on the part or a nearby "
    "label. The format is PCMRS followed by digits (e.g. PCMRS0700648). "
    "Return ONLY the serial number as plain text, no other words. "
    "If no serial number is visible, respond with exactly: NONE"
)


def _to_jpg_bytes(path: Path, longest: int = OCR_LONGEST_SIDE, quality: int = 85) -> bytes:
    img = Image.open(path)
    img.thumbnail((longest, longest), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _normalize(digits: str, valid_sns: set[str]) -> Optional[str]:
    """Try 3-digit tail, 4-digit → leading/trailing 3, against DB set."""
    if len(digits) == 3:
        cand = f"PCMRS0700{digits}"
        return cand if cand in valid_sns else None
    if len(digits) >= 4:
        for slc in (digits[:3], digits[-3:]):
            cand = f"PCMRS0700{slc}"
            if cand in valid_sns:
                return cand
    return None


def _extract_sn_from_text(text: str, valid_sns: set[str]) -> Optional[str]:
    for m in RAW_SN_RE.finditer(text):
        sn = _normalize(m.group(1), valid_sns)
        if sn:
            return sn
    return None


@dataclass
class SnResult:
    filename: str
    sn: Optional[str]
    raw_text: str
    source: str  # "claude" | "ocrmac" | "cached"


class SnExtractor:
    """Batch-friendly SN extractor with on-disk cache."""

    def __init__(self, cfg: Config, valid_sns: set[str]):
        self.cfg = cfg
        self.valid_sns = valid_sns
        self._client: Anthropic | None = None
        self._cache: dict[str, dict] = {}
        self._cache_path = cfg.runtime.ocr_cache_path
        if self._cache_path.exists():
            try:
                self._cache = json.loads(self._cache_path.read_text())
            except Exception:
                self._cache = {}

    # -- client lazy-init so tests don't need a real API key
    @property
    def client(self) -> Anthropic:
        if self._client is None:
            self._client = Anthropic(api_key=self.cfg.anthropic.api_key)
        return self._client

    def _cache_key(self, path: Path) -> str:
        return f"{path.name}::v3_claude"

    def _save_cache(self) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(json.dumps(self._cache, indent=0))

    def extract_one(self, path: Path) -> SnResult:
        key = self._cache_key(path)
        if key in self._cache:
            c = self._cache[key]
            return SnResult(path.name, c.get("sn"), c.get("raw", ""), source="cached")

        jpg = _to_jpg_bytes(path)
        b64 = base64.standard_b64encode(jpg).decode("ascii")
        resp = self.client.messages.create(
            model=self.cfg.anthropic.model,
            max_tokens=64,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
                        },
                        {"type": "text", "text": CLAUDE_PROMPT},
                    ],
                }
            ],
        )
        text = "".join(
            block.text for block in resp.content if getattr(block, "type", "") == "text"
        ).strip()
        sn = None if text.upper() == "NONE" else _extract_sn_from_text(text, self.valid_sns)
        # If Claude gave us digits without the SN prefix, try lifting them
        if sn is None and text and text.upper() != "NONE":
            just_digits = re.findall(r"\d{3,5}", text)
            for d in just_digits:
                sn = _normalize(d, self.valid_sns)
                if sn:
                    break

        self._cache[key] = {"sn": sn, "raw": text}
        return SnResult(path.name, sn, text, source="claude")

    def extract_many(self, paths: list[Path], on_progress=None) -> list[SnResult]:
        results: list[SnResult] = []
        try:
            for i, p in enumerate(paths, 1):
                results.append(self.extract_one(p))
                if on_progress and i % 25 == 0:
                    on_progress(i, len(paths))
        finally:
            self._save_cache()
        return results


# -- helper for match.py -------------------------------------------------

def photo_ts(path: Path):
    from datetime import datetime as _dt
    try:
        img = Image.open(path)
        exif = img.getexif()
        for tag_id, val in exif.items():
            name = ExifTags.TAGS.get(tag_id, "")
            if name in ("DateTimeOriginal", "DateTime") and val:
                return _dt.strptime(val, "%Y:%m:%d %H:%M:%S")
    except Exception:
        pass
    try:
        return _dt.fromtimestamp(path.stat().st_mtime)
    except OSError:
        return None
