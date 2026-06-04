#!/usr/bin/env python3
"""
Turn 360° equirectangular panos (and an optional video walkthrough) into a set
of overlapping rectilinear (pinhole) images suitable for COLMAP + 3D Gaussian
Splatting.

Why: Marble (World Labs) is a *generative* model and hallucinates unseen
geometry. For a faithful as-built reconstruction we run a real photogrammetry
pipeline, which needs perspective images with shared intrinsics — not
equirectangular panos. This script samples each pano into yaw/pitch views with
generous overlap (good for Structure-from-Motion), and optionally extracts
video frames into the same folder.

Usage:
  python tools/panos_to_perspective.py \
      --panos 360_World_Labs_Pinion_Guide \
      --video walkthrough.mp4 \
      --out reconstruction/images

Then zip `reconstruction/images` and feed it to the Colab notebook
(tools/gaussian_splatting_colab.ipynb).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Perspective sampling. 8 yaw steps (45°) at 3 pitches gives ~50% horizontal
# overlap between neighbours — COLMAP likes lots of overlap.
# v360 expects yaw in [-180, 180]; these 8 still span the full circle.
YAWS = [-135, -90, -45, 0, 45, 90, 135, 180]
PITCHES = [-25, 0, 25]
H_FOV = 90
V_FOV = 73
OUT_W = 1280
OUT_H = 960
# Equirectangular input is upright; sample the full sphere except straight
# up/down (ceiling/floor add little and confuse SfM).

IMG_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def pano_to_views(pano: Path, out_dir: Path, stem: str) -> int:
    n = 0
    for pi, pitch in enumerate(PITCHES):
        for yi, yaw in enumerate(YAWS):
            out = out_dir / f"{stem}_p{pi}_y{yi:02d}.jpg"
            vf = (
                f"v360=e:flat:yaw={yaw}:pitch={pitch}:"
                f"h_fov={H_FOV}:v_fov={V_FOV}:w={OUT_W}:h={OUT_H}:interp=cubic"
            )
            run(["ffmpeg", "-y", "-i", str(pano), "-vf", vf, "-frames:v", "1", str(out)])
            n += 1
    return n


def video_to_frames(video: Path, out_dir: Path, fps: float) -> int:
    # Flat (non-360) video: extract frames at the given fps.
    pattern = str(out_dir / "vid_%05d.jpg")
    run([
        "ffmpeg", "-y", "-i", str(video),
        "-vf", f"fps={fps},scale='min(1600,iw)':-2",
        "-q:v", "3", pattern,
    ])
    return len(list(out_dir.glob("vid_*.jpg")))


# For a 360 (equirectangular) video we sample fewer directions per frame than
# for a static pano — the camera motion already supplies many viewpoints, and
# we must keep the total image count sane for COLMAP on free Colab.
VIDEO_YAWS = [-120, -60, 0, 60, 120, 180]
VIDEO_PITCH = -10


def video360_to_views(video: Path, out_dir: Path, fps: float) -> int:
    # One ffmpeg pass per direction: decode once, fps-sample, reproject to a
    # rectilinear view. Frames are numbered per-direction so they don't collide.
    total = 0
    for yi, yaw in enumerate(VIDEO_YAWS):
        pattern = str(out_dir / f"vid_y{yi}_%05d.jpg")
        vf = (
            f"fps={fps},v360=e:flat:yaw={yaw}:pitch={VIDEO_PITCH}:"
            f"h_fov={H_FOV}:v_fov={V_FOV}:w={OUT_W}:h={OUT_H}:interp=cubic"
        )
        run(["ffmpeg", "-y", "-i", str(video), "-vf", vf, "-q:v", "3", pattern])
        made = len(list(out_dir.glob(f"vid_y{yi}_*.jpg")))
        total += made
        print(f"    yaw {yaw:>4}\u00b0 -> {made} frames")
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--panos", type=Path, help="Directory of equirectangular panos")
    ap.add_argument("--video", type=Path, help="Optional flat (rectilinear) walkthrough video")
    ap.add_argument("--video360", type=Path, help="Optional 360 (equirectangular) walkthrough video")
    ap.add_argument("--fps", type=float, default=2.0, help="Frames/sec to sample from video")
    ap.add_argument("--out", type=Path, default=Path("reconstruction/images"))
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    total = 0

    if args.panos:
        panos = sorted(p for p in args.panos.iterdir() if p.suffix.lower() in IMG_EXTS)
        if not panos:
            print(f"No images found in {args.panos}", file=sys.stderr)
        for i, pano in enumerate(panos):
            stem = f"pano{i:02d}"
            made = pano_to_views(pano, args.out, stem)
            total += made
            print(f"  {pano.name} -> {made} views")

    if args.video360:
        if not args.video360.exists():
            print(f"360 video not found: {args.video360}", file=sys.stderr)
            return 1
        print(f"  {args.video360.name} (360) @ {args.fps}fps:")
        made = video360_to_views(args.video360, args.out, args.fps)
        total += made
        print(f"  {args.video360.name} -> {made} perspective views")

    if args.video:
        if not args.video.exists():
            print(f"Video not found: {args.video}", file=sys.stderr)
            return 1
        made = video_to_frames(args.video, args.out, args.fps)
        total += made
        print(f"  {args.video.name} -> {made} frames @ {args.fps}fps")

    print(f"\nTotal images: {total}  ->  {args.out}")
    print("Next: zip this folder and run tools/gaussian_splatting_colab.ipynb on free Colab.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
