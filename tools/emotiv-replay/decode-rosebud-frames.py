#!/usr/bin/env python3
"""Decode tag36h11 on a folder of frames.

The frames are already cut. One record per file, in name order. `corners` is
the detector's own order, which is the order `rosebudPlace.js` measures.
Prints a JSON list and writes nothing else.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from pupil_apriltags import Detector


def side_of(corners) -> float:
    xs = corners[:, 0]
    ys = corners[:, 1]
    return float(max(xs.max() - xs.min(), ys.max() - ys.min()))


def main() -> None:
    folder = Path(sys.argv[1])
    frames = sorted(folder.glob("f-*.jpg"))
    detector = Detector(families="tag36h11", nthreads=4, quad_decimate=1.0)
    out = []
    for frame in frames:
        gray = np.asarray(Image.open(frame).convert("L"))
        tags = {}
        for hit in detector.detect(gray):
            corners = np.asarray(hit.corners, dtype=float)
            tags[str(int(hit.tag_id))] = {
                "cx": round(float(hit.center[0]), 1),
                "cy": round(float(hit.center[1]), 1),
                "side": round(side_of(corners), 1),
                "corners": [[round(float(x), 1), round(float(y), 1)] for x, y in corners],
            }
        out.append({"file": frame.name, "tags": tags})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
