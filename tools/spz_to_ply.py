#!/usr/bin/env python3
"""
spz_to_ply.py — decode a Niantic .spz Gaussian-splat file to a standard 3DGS .ply.

Used to pull a World Labs (Marble) world's Gaussians out of the .spz our proxy
serves so we can merge/align them with our COLMAP+splatfacto reconstruction.

Implements the format from https://github.com/nianticlabs/spz (load-spz.cc):
  16-byte header, then attributes IN THIS ORDER:
    positions  : n*3 * int24 LE (signed) / 2**fractionalBits
    alphas     : n   * uint8   -> opacity = invSigmoid(a/255)
    colors     : n*3 * uint8   -> f_dc    = (c/255 - 0.5)/0.15
    scales     : n*3 * uint8   -> log scale = s/16 - 10
    rotations  : v2 = n*3 (xyz, w derived) ; v3/v4 = n*4 (smallest-three)
    sh         : n * shDim*3 * uint8 -> (x-128)/128   (shDim by degree)

The .ply is written in the Inria/nerfstudio layout (rot = w,x,y,z; SH channel-major
f_rest) so it round-trips through the same tooling as our exported splats.
"""
import argparse
import gzip
import os
import struct
import sys

import numpy as np

SH_DIM = {0: 0, 1: 3, 2: 8, 3: 15, 4: 24}  # coeffs per channel (excl. DC)
COLOR_SCALE = 0.15
SQRT1_2 = 0.7071067811865476


def _read(path: str) -> bytes:
    with open(path, "rb") as f:
        head = f.read(2)
        f.seek(0)
        raw = f.read()
    if head == b"\x1f\x8b":  # gzip magic
        return gzip.decompress(raw)
    return raw


def decode_spz(path: str):
    buf = _read(path)
    magic, ver, n = struct.unpack_from("<III", buf, 0)
    sh_deg, frac_bits, flags, _res = struct.unpack_from("<BBBB", buf, 12)
    if magic != 0x5053474E:
        raise ValueError(f"bad SPZ magic {hex(magic)}")
    sh_dim = SH_DIM[sh_deg]
    rot_bytes = 4 if ver >= 3 else 3
    off = 16

    def take(count):
        nonlocal off
        a = np.frombuffer(buf, np.uint8, count, off)
        off += count
        return a

    # positions: int24 LE signed
    pb = take(n * 9).reshape(n * 3, 3).astype(np.int32)
    fixed = pb[:, 0] | (pb[:, 1] << 8) | (pb[:, 2] << 16)
    fixed = np.where(fixed & 0x800000, fixed | ~0xFFFFFF, fixed)
    pos = (fixed.astype(np.float32) / (1 << frac_bits)).reshape(n, 3)

    # alphas -> opacity logit
    a = take(n).astype(np.float32)
    a = np.clip(a / 255.0, 1e-6, 1 - 1e-6)
    opacity = np.log(a / (1 - a)).reshape(n, 1)

    # colors -> f_dc
    c = take(n * 3).astype(np.float32).reshape(n, 3)
    f_dc = (c / 255.0 - 0.5) / COLOR_SCALE

    # scales (log)
    s = take(n * 3).astype(np.float32).reshape(n, 3)
    scales = s / 16.0 - 10.0

    # rotations -> quaternion (w,x,y,z)
    rb = take(n * rot_bytes)
    if rot_bytes == 3:
        xyz = rb.astype(np.float32).reshape(n, 3) / 127.5 - 1.0
        xyz = np.maximum(xyz, -1.0)
        w = np.sqrt(np.maximum(0.0, 1.0 - (xyz * xyz).sum(1)))
        quat = np.column_stack([w, xyz]).astype(np.float32)  # w,x,y,z
    else:
        comp = (
            rb.reshape(n, 4)[:, 0].astype(np.uint32)
            | (rb.reshape(n, 4)[:, 1].astype(np.uint32) << 8)
            | (rb.reshape(n, 4)[:, 2].astype(np.uint32) << 16)
            | (rb.reshape(n, 4)[:, 3].astype(np.uint32) << 24)
        )
        i_largest = (comp >> 30) & 0x3
        q = np.zeros((n, 4), np.float32)  # xyzw temp
        rem = comp
        mask9 = float((1 << 9) - 1)
        idxs = [3, 2, 1, 0]  # fill order high->low excluding largest handled below
        # decode three smallest in order i=3,2,1,0 skipping largest
        ssq = np.zeros(n, np.float32)
        order = []
        for i in range(4):
            order.append(i)
        # reproduce reference loop (i from high to low), bit layout: [idx(2)][c0(10)][c1(10)][c2(10)]
        rem = comp
        filled = np.zeros((n, 4), bool)
        for i in range(3, -1, -1):
            is_large = i_largest == i
            mag = (rem & 0x1FF).astype(np.float32)
            negbit = (rem >> 9) & 0x1
            val = SQRT1_2 * mag / mask9
            val = np.where(negbit == 1, -val, val)
            # only assign where this i is NOT the largest
            assign = ~is_large
            q[assign, i] = val[assign]
            ssq[assign] += (val * val)[assign]
            rem = np.where(assign, rem >> 10, rem)
        wlarge = np.sqrt(np.maximum(0.0, 1.0 - ssq))
        for i in range(4):
            sel = i_largest == i
            q[sel, i] = wlarge[sel]
        quat = q[:, [3, 0, 1, 2]]  # xyzw -> wxyz

    # sh (rest)
    if sh_dim > 0:
        sh = take(n * sh_dim * 3).astype(np.float32).reshape(n, sh_dim, 3)
        sh = (sh - 128.0) / 128.0
    else:
        sh = np.zeros((n, 0, 3), np.float32)

    return {
        "version": ver,
        "sh_degree": sh_deg,
        "pos": pos,
        "f_dc": f_dc,
        "f_rest": sh,  # (n, sh_dim, 3)
        "opacity": opacity,
        "scales": scales,
        "quat": quat,  # (n,4) wxyz
    }


def write_ply(g, out_path: str, rub_to_rdf: bool = True):
    pos = g["pos"].copy()
    quat = g["quat"].copy()
    if rub_to_rdf:
        # SPZ default is RUB (right-up-back). Flip Y,Z to match the Inria/COLMAP
        # RDF convention most .ply viewers expect (180° about X -> proper rot).
        pos[:, 1] *= -1
        pos[:, 2] *= -1
        # rotate quaternion by Rx(180): (w,x,y,z) -> (x, w, -z, y)?  apply q' = qx * q
        # Rx(180) quaternion = (0,1,0,0); left-multiply: q' = qrot ⊗ q
        w, x, y, z = quat[:, 0], quat[:, 1], quat[:, 2], quat[:, 3]
        quat = np.column_stack([-x, w, -z, y]).astype(np.float32)

    n = pos.shape[0]
    sh_dim = g["f_rest"].shape[1]
    cols, names = [], []
    for i, nm in enumerate("xyz"):
        cols.append(pos[:, i]); names.append(nm)
    for nm in ("nx", "ny", "nz"):
        cols.append(np.zeros(n, np.float32)); names.append(nm)
    for i in range(3):
        cols.append(g["f_dc"][:, i]); names.append(f"f_dc_{i}")
    if sh_dim > 0:
        fr = np.transpose(g["f_rest"], (0, 2, 1)).reshape(n, 3 * sh_dim)  # channel-major
        for i in range(3 * sh_dim):
            cols.append(fr[:, i]); names.append(f"f_rest_{i}")
    cols.append(g["opacity"][:, 0]); names.append("opacity")
    for i in range(3):
        cols.append(g["scales"][:, i]); names.append(f"scale_{i}")
    for i in range(4):
        cols.append(quat[:, i]); names.append(f"rot_{i}")

    data = np.stack(cols, axis=1).astype("<f4")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        hdr = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n"
        hdr += "".join(f"property float {nm}\n" for nm in names) + "end_header\n"
        f.write(hdr.encode("ascii"))
        f.write(data.tobytes())
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spz")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--keep-rub", action="store_true",
                    help="do not flip RUB->RDF (keep SPZ native axes)")
    args = ap.parse_args()

    g = decode_spz(args.spz)
    p = g["pos"]
    lo, hi = p.min(0), p.max(0)
    print(f"version={g['version']} sh_degree={g['sh_degree']} gaussians={p.shape[0]:,}")
    print(f"bbox min={lo.round(3)} max={hi.round(3)} extent={(hi-lo).round(3)}")
    print(f"centroid={p.mean(0).round(3)} median_abs={np.median(np.abs(p),0).round(3)}")
    out = write_ply(g, args.out, rub_to_rdf=not args.keep_rub)
    print(f"wrote {out} ({os.path.getsize(out)/1e6:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
