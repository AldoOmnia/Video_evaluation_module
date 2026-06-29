#!/usr/bin/env python3
"""Add missing buffer:0 to glTF bufferViews (Three.js GLTFLoader requirement).

Some exporters (Omniverse, etc.) omit the buffer index on bufferViews; Three.js
then fails texture load and the viewer falls back to another operator GLB.

Usage:
  python3 scripts/fix-glb-bufferviews.py eval-lab/public/assets/Worker/Worker.glb
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def patch_glb(path: Path) -> int:
    data = bytearray(path.read_bytes())
    if data[:4] != b"glTF":
        raise SystemExit(f"Not a GLB: {path}")

    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + json_len])

    fixed = 0
    for bv in gltf.get("bufferViews", []):
        if "buffer" not in bv:
            bv["buffer"] = 0
            fixed += 1

    if fixed == 0:
        print(f"No changes needed: {path}")
        return 0

    new_json = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(new_json) % 4:
        new_json += b" "

    bin_start = 20 + json_len + 8
    bin_data = bytes(data[bin_start:])

    out = bytearray()
    out += b"glTF"
    out += struct.pack("<II", 2, 12 + 8 + len(new_json) + 8 + len(bin_data))
    out += struct.pack("<I4s", len(new_json), b"JSON")
    out += new_json
    out += struct.pack("<I4s", len(bin_data), b"BIN\x00")
    out += bin_data

    path.write_bytes(out)
    print(f"Patched {fixed} bufferViews → {path} ({len(out) / 1024 / 1024:.1f} MB)")
    return fixed


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: fix-glb-bufferviews.py <file.glb> [more.glb ...]", file=sys.stderr)
        return 1
    for arg in sys.argv[1:]:
        patch_glb(Path(arg))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
