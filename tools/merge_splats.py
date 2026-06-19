#!/usr/bin/env python3
"""
merge_splats.py — fuse our faithful COLMAP/splatfacto splat with a World Labs
splat into ONE .ply: ours where we have real coverage, World Labs only in the
gaps (carved), so there are no double surfaces.

The hard part is that the two splats live in different arbitrary frames. We:
  1. robust-center both (subtract per-axis median; ignores far floaters),
  2. isotropically scale WL to match our robust radius,
  3. search the 24 axis-aligned proper rotations and keep the one that MAXIMISES
     occupied-voxel overlap (IoU) — a measurable alignment score,
  4. carve WL gaussians whose voxel is already occupied by ours (keep only fill),
  5. concatenate, prune by opacity to a web budget, write an SH0 .ply.

The reported best IoU is the honesty check: high (>~0.3) => the rooms aligned and
the fill is meaningful; low => the hallucinated geometry doesn't match ours and
a manual point-pair alignment (CloudCompare/SuperSplat) is needed instead.
"""
import argparse
import itertools
import os

import numpy as np


def read_ply(path):
    f = open(path, "rb")
    assert f.readline().strip() == b"ply"
    f.readline()  # format
    n = 0
    props = []
    while True:
        ln = f.readline().strip()
        if ln == b"end_header":
            break
        if ln.startswith(b"element vertex"):
            n = int(ln.split()[-1])
        elif ln.startswith(b"property float"):
            props.append(ln.split()[-1].decode())
    arr = np.frombuffer(f.read(n * len(props) * 4), "<f4").reshape(n, len(props))
    f.close()
    idx = {nm: i for i, nm in enumerate(props)}
    g = {
        "pos": arr[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float32),
        "f_dc": arr[:, [idx["f_dc_0"], idx["f_dc_1"], idx["f_dc_2"]]].astype(np.float32),
        "opacity": arr[:, idx["opacity"]].astype(np.float32),
        "scale": arr[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]].astype(np.float32),
        "quat": arr[:, [idx["rot_0"], idx["rot_1"], idx["rot_2"], idx["rot_3"]]].astype(np.float32),
    }
    return g


def robust_center_radius(p):
    c = np.median(p, axis=0)
    d = np.linalg.norm(p - c, axis=1)
    r = np.median(d)  # robust radius
    return c, r


def voxel_keys(p, v):
    q = np.floor(p / v).astype(np.int64)
    # pack into one int64 key (assumes |coord| < ~1e6 voxels)
    return (q[:, 0] + (1 << 21)) | ((q[:, 1] + (1 << 21)) << 21) | ((q[:, 2] + (1 << 21)) << 42)


def proper_rotations():
    mats = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product([1, -1], repeat=3):
            M = np.zeros((3, 3), np.float32)
            for i, p in enumerate(perm):
                M[i, p] = signs[i]
            if round(np.linalg.det(M)) == 1:
                mats.append(M)
    return mats  # 24


def icp_refine(src, dst, R0, iters=40, sample=60000, trim=0.7):
    """Point-to-point ICP (Kabsch) refining rotation+translation of src->dst.
    Robust: each iteration keeps only the closest `trim` fraction of matches.
    Returns refined R, t and final inlier RMSE."""
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(0)
    si = rng.choice(src.shape[0], min(sample, src.shape[0]), replace=False)
    di = rng.choice(dst.shape[0], min(sample, dst.shape[0]), replace=False)
    S0 = src[si]
    tree = cKDTree(dst[di])
    R = R0.astype(np.float64).copy()
    t = np.zeros(3)
    rmse = np.inf
    for _ in range(iters):
        S = S0 @ R.T + t
        d, j = tree.query(S, k=1)
        k = max(100, int(len(d) * trim))
        sel = np.argpartition(d, k - 1)[:k]
        A, B = S0[sel], dst[di][j[sel]]
        ca, cb = A.mean(0), B.mean(0)
        H = (A - ca).T @ (B - cb)
        U, _, Vt = np.linalg.svd(H)
        Rk = Vt.T @ U.T
        if np.linalg.det(Rk) < 0:
            Vt[-1] *= -1
            Rk = Vt.T @ U.T
        R = Rk
        t = cb - ca @ R.T
        rmse = float(np.sqrt((d[sel] ** 2).mean()))
    return R.astype(np.float32), t.astype(np.float32), rmse


def quat_mul(a, b):
    aw, ax, ay, az = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bw, bx, by, bz = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ], axis=-1)


def mat_to_quat(M):
    t = np.trace(M)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (M[2, 1] - M[1, 2]) / s
        y = (M[0, 2] - M[2, 0]) / s
        z = (M[1, 0] - M[0, 1]) / s
    elif M[0, 0] > M[1, 1] and M[0, 0] > M[2, 2]:
        s = np.sqrt(1.0 + M[0, 0] - M[1, 1] - M[2, 2]) * 2
        w = (M[2, 1] - M[1, 2]) / s; x = 0.25 * s
        y = (M[0, 1] + M[1, 0]) / s; z = (M[0, 2] + M[2, 0]) / s
    elif M[1, 1] > M[2, 2]:
        s = np.sqrt(1.0 + M[1, 1] - M[0, 0] - M[2, 2]) * 2
        w = (M[0, 2] - M[2, 0]) / s; x = (M[0, 1] + M[1, 0]) / s
        y = 0.25 * s; z = (M[1, 2] + M[2, 1]) / s
    else:
        s = np.sqrt(1.0 + M[2, 2] - M[0, 0] - M[1, 1]) * 2
        w = (M[1, 0] - M[0, 1]) / s; x = (M[0, 2] + M[2, 0]) / s
        y = (M[1, 2] + M[2, 1]) / s; z = 0.25 * s
    return np.array([w, x, y, z], np.float32)


def write_ply_sh0(g, out):
    n = g["pos"].shape[0]
    cols, names = [], []
    for i, nm in enumerate("xyz"):
        cols.append(g["pos"][:, i]); names.append(nm)
    for i in range(3):
        cols.append(g["f_dc"][:, i]); names.append(f"f_dc_{i}")
    cols.append(g["opacity"]); names.append("opacity")
    for i in range(3):
        cols.append(g["scale"][:, i]); names.append(f"scale_{i}")
    for i in range(4):
        cols.append(g["quat"][:, i]); names.append(f"rot_{i}")
    data = np.stack(cols, 1).astype("<f4")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "wb") as f:
        hdr = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n"
        hdr += "".join(f"property float {nm}\n" for nm in names) + "end_header\n"
        f.write(hdr.encode("ascii")); f.write(data.tobytes())
    print(f"wrote {out} ({os.path.getsize(out)/1e6:.1f} MB, {n:,} gaussians)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", required=True)
    ap.add_argument("--wl", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-points", type=int, default=1_600_000)
    ap.add_argument("--carve-vox", type=float, default=0.03,
                    help="voxel size (in OUR units) for overlap carving")
    ap.add_argument("--no-icp", action="store_true", help="skip ICP refinement")
    args = ap.parse_args()

    ours = read_ply(args.ours)
    wl = read_ply(args.wl)
    print(f"ours {ours['pos'].shape[0]:,}  wl {wl['pos'].shape[0]:,}")

    co, ro = robust_center_radius(ours["pos"])
    cw, rw = robust_center_radius(wl["pos"])
    print(f"ours center={co.round(3)} radius={ro:.3f} | wl center={cw.round(3)} radius={rw:.3f}")

    s = ro / rw  # isotropic scale wl -> ours
    P_ours = ours["pos"] - co
    P_wl0 = (wl["pos"] - cw) * s

    # trim far floaters for a fair, fast overlap search (keep within ~6 robust radii)
    keep_o = np.linalg.norm(P_ours, axis=1) < 6 * ro
    keep_w = np.linalg.norm(P_wl0, axis=1) < 6 * ro
    Ao, Aw = P_ours[keep_o], P_wl0[keep_w]
    v = ro * 0.15  # search voxel
    ko = set(voxel_keys(Ao, v).tolist())

    best = (-1.0, None)
    for M in proper_rotations():
        Awr = Aw @ M.T
        kw = set(voxel_keys(Awr, v).tolist())
        inter = len(ko & kw)
        iou = inter / (len(ko) + len(kw) - inter + 1e-9)
        if iou > best[0]:
            best = (iou, M)
    iou, M = best
    print(f"best axis-aligned overlap IoU = {iou:.3f}")

    # ICP refine the rotation/translation beyond the axis-aligned guess
    t_ref = np.zeros(3, np.float32)
    if not args.no_icp:
        R, t_ref, rmse = icp_refine(Aw, Ao, M)
        kw = set(voxel_keys(Aw @ R.T + t_ref, v).tolist())
        inter = len(ko & kw)
        iou_ref = inter / (len(ko) + len(kw) - inter + 1e-9)
        print(f"after ICP: IoU = {iou_ref:.3f}  rmse = {rmse:.4f} (our units)")
        if iou_ref >= iou:
            M = R
        else:
            print("  ICP did not improve overlap — keeping axis-aligned")
            t_ref = np.zeros(3, np.float32)

    # apply chosen transform to ALL wl points (positions + rotate quats)
    P_wl = P_wl0 @ M.T + t_ref
    qrot = mat_to_quat(M)
    wl_quat = quat_mul(np.broadcast_to(qrot, wl["quat"].shape), wl["quat"])
    wl_scale = wl["scale"] + np.log(s)  # log-scale shift for isotropic scaling

    # carve: drop wl points whose voxel is already occupied by ours
    ko_carve = set(voxel_keys(P_ours, args.carve_vox).tolist())
    kw_all = voxel_keys(P_wl, args.carve_vox)
    occupied = np.fromiter((k in ko_carve for k in kw_all.tolist()), bool, count=len(kw_all))
    fill = ~occupied
    # also drop wl points far outside our scene (avoid giant hallucinated sky/floor)
    inb = np.linalg.norm(P_wl, axis=1) < 5 * ro
    fill &= inb
    print(f"wl fill gaussians kept: {fill.sum():,} / {len(fill):,}")

    merged = {
        "pos": np.vstack([P_ours + co, P_wl[fill] + co]),
        "f_dc": np.vstack([ours["f_dc"], wl["f_dc"][fill]]),
        "opacity": np.concatenate([ours["opacity"], wl["opacity"][fill]]),
        "scale": np.vstack([ours["scale"], wl_scale[fill]]),
        "quat": np.vstack([ours["quat"], wl_quat[fill]]),
    }

    # prune by opacity to web budget
    n = merged["pos"].shape[0]
    if n > args.max_points:
        order = np.argsort(-merged["opacity"])[: args.max_points]
        for k in merged:
            merged[k] = merged[k][order]
        print(f"pruned {n:,} -> {args.max_points:,} by opacity")

    write_ply_sh0(merged, args.out)


if __name__ == "__main__":
    main()
