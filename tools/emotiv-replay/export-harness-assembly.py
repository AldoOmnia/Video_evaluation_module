#!/usr/bin/env python3
"""Export the A2LL wire harness the Spark shows, for the Emotiv station page.

Two steps, because the stage lives on the Spark and the mesh reducer does not.

1. On the Spark, read the photo stage (the harness CAD with the bench colours
   bound on top) and write every solid untouched:

    python export-harness-assembly.py --dump \
        --stage ~/Desktop/harness-connectors-A2LL-A2SL/reconciliation/a2ll_photo.usda \
        --binding ~/Desktop/harness-connectors-A2LL-A2SL/reconciliation/connector_binding.json \
        --out /tmp/harness-raw

   Needs pxr (OpenUSD) and numpy.

2. Anywhere with fast-simplification, reduce each solid on its own and write
   the page's files:

    python export-harness-assembly.py --build /tmp/harness-raw \
        --out eval-lab/public/assets/emotiv/harness

Each solid is welded and reduced by itself, so a connector keeps its edges and
a wire keeps its run. The cross car beam is its own layer, so the page can
take it away.

AprilTag cards. The Spark contact sheet puts a card on every clip solid in
the order along the beam (tag 8 at the driver end, tag 73 at the passenger
end) and says those numbers are not the rosebud WH-AZ names. The printed tags
on the bench are the registry's: tag 18 is driver side A pillar 2, and so on.
`BOUND` ties six of those to a clip solid, set by hand. The passenger pillars
ride the thin wire along the top tube, which is where the 12 Nov recordings
show them, and each pair sits as far apart in the CAD as the tags sit in
those recordings. Pillar 6 and driver pillar 2 are the end clips by the two
speaker connectors. The rest have no clip named for them yet.
"""
import argparse
import json
import os
import struct

import numpy as np

# The Spark contact sheet, driver end to passenger end. Part prefixes are the
# GM numbers printed under each card. Two of them are not in this extract.
SHEET = [
    (8, "84389041"), (9, "95227417"), (10, "13596780"), (11, "13596780"),
    (12, "95227417"), (13, "84112514"), (14, "84389041"), (15, "95227417"),
    (16, "84389041"), (17, "95227417"), (18, "84389041"), (19, "95227417"),
    (20, "84112519"), (21, "13596780"), (22, "95227417"), (23, "84389041"),
    (24, "95227417"), (25, "13594447"), (26, "84389041"), (27, "84035392"),
    (28, "26248254"), (29, "84088963"), (30, "84112532"), (31, "84389041"),
    (32, "84389041"), (33, "13594448"), (34, "84389041"), (35, "95227417"),
    (36, "84389041"), (37, "13144735"), (38, "95227417"), (39, "84199109"),
    (40, "13144735"), (41, "84389041"), (42, "95227417"), (43, "13596780"),
    (44, "95227417"), (45, "13144735"), (46, "13248125"), (47, "84389041"),
    (48, "95227417"), (49, "95227417"), (50, "84389041"), (51, "13596804"),
    (52, "84389041"), (53, "13594445"), (54, "84389041"), (55, "84389041"),
    (56, "95227417"), (57, "84389041"), (58, "13144735"), (59, "95227417"),
    (60, "84389041"), (61, "95227417"), (62, "95227417"), (63, "84389041"),
    (64, "84602060"), (65, "84602060"), (66, "95227417"), (67, "84389041"),
    (68, "95227417"), (69, "95227417"), (70, "95227417"), (71, "95227417"),
    (72, "13596790"), (73, "95227417"),
]
# Extremity cards the registry puts by one connector. The rest of 0-7 name a
# bundle rather than one solid, so they are not given a spot here.
FIXED = [(0, "WH-EZ18-01"), (2, "WH-EZ2-01"), (3, "WH-EC-51"), (5, "WH-EZ18-02")]
CARD = (0.020, 0.013)  # the printed flag, metres, along Y then X
ABSENT = {"26248254", "84199109"}

# Printed tag -> the clip solid it rides on, named by that clip's place in the
# Spark sheet. Set by hand. --build checks every row and stops if the CAD
# moves off it.
BOUND = [
    # tag, rosebud, zone, pillar, words, sheet place
    (17, "WH-AZ5-01", "AZ5", 1, "Driver side A pillar 1", 12),
    (18, "WH-AZ5-02", "AZ5", 2, "Driver side A pillar 2", 9),
    # The thin wire along the top tube, out to the end bracket.
    (20, "WH-AZ6-02", "AZ6", 2, "Passenger side A pillar 2", 54),
    (21, "WH-AZ6-03", "AZ6", 3, "Passenger side A pillar 3", 60),
    (22, "WH-AZ6-04", "AZ6", 4, "Passenger side A pillar 4", 63),
    (24, "WH-AZ6-06", "AZ6", 6, "Passenger side A pillar 6", 71),
]
# (tag a, tag b, mm between them in the picture, source). Tag-to-tag distance
# over tag width, median, with a 10 mm marker. The CAD has to land within 15
# percent. The passenger rows were read off the 12 Nov recordings on the page
# with OpenCV's tag36h11 detector; the driver row is rosebudPitch.js.
SPACING = [
    (17, 18, 76, "AZ5:1-2 nominal 7.63, rosebudPitch.js"),
    (20, 21, 143, "missed take, 282 frames"),
    (21, 22, 132, "missed take, 244 frames"),
    (20, 22, 263, "missed take, 246 frames"),
    (22, 24, 190, "pillar 6 take, 137 frames, 175 to 210 across both takes"),
    (21, 24, 307, "missed take, 21 frames"),
    (20, 24, 423, "missed take, 22 frames"),
]
# (tag, connector): the tag's clip has to be the clip nearest that connector.
END_CLIP = [(18, "WH-EZ18-01"), (24, "WH-EZ18-03")]
ZONES = {
    "AZ5": {"words": "Driver side A pillar", "expected": 2},
    "AZ6": {"words": "Passenger side A pillar", "expected": 6},
}

KINDS = ["connector", "clip", "wire", "part", "beam"]


# ---------------------------------------------------------------- the Spark

def colour_of(prim):
    """Diffuse colour, whether the bound material is metal, and its name."""
    mat = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
    if not mat:
        return (0.62, 0.63, 0.65), False, ""
    name = mat.GetPath().name
    metal = "Steel" in name or "Metal" in name
    shader = UsdShade.Shader(mat.GetPrim().GetChild("Shader"))
    diffuse = shader.GetInput("diffuseColor").Get() if shader else None
    if diffuse is None:
        return ((0.72, 0.73, 0.75) if metal else (0.62, 0.63, 0.65)), metal, name
    return (float(diffuse[0]), float(diffuse[1]), float(diffuse[2])), metal, name


def fan(counts, idx):
    """Triangles of a face list. CAD faces are quads and the odd n-gon."""
    counts = np.asarray(counts, dtype=np.int64)
    idx = np.asarray(idx, dtype=np.int64)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    out = []
    for n in np.unique(counts):
        if n < 3:
            continue
        s = starts[counts == n]
        for k in range(1, int(n) - 1):
            out.append(np.stack([idx[s], idx[s + k], idx[s + k + 1]], axis=1))
    return np.concatenate(out) if out else None


def dump(args):
    from pxr import Usd, UsdGeom, UsdShade
    globals()["Usd"], globals()["UsdGeom"], globals()["UsdShade"] = Usd, UsdGeom, UsdShade
    os.makedirs(args.out, exist_ok=True)
    stage = Usd.Stage.Open(args.stage, Usd.Stage.LoadAll)
    xform = UsdGeom.XformCache()
    box_cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
    root = stage.GetPrimAtPath("/A2LL")
    binding = json.load(open(args.binding))
    by_id = {row["wh_id"]: row for row in binding["placed"]}
    conn_paths = [row["prim_path"] for row in binding["placed"]]

    # Clip solids, sorted along the beam, which is Y, driver at the negative end.
    prefixes = sorted({p for _, p in SHEET})
    clips = []
    for prim in stage.Traverse():
        name = prim.GetName()
        parent = prim.GetParent().GetName() if prim.GetParent() else ""
        hit = next((k for k in prefixes if k in name and k not in parent), None)
        if not hit:
            continue
        bound = box_cache.ComputeWorldBound(prim).ComputeAlignedRange()
        if bound.IsEmpty():
            continue
        lo, hi = bound.GetMin(), bound.GetMax()
        c = [(lo[i] + hi[i]) / 2 for i in range(3)]
        clips.append((c[1], c[0], hit, c, hi[2], str(prim.GetPath())))
    clips.sort()
    clip_paths = [c[5] for c in clips]

    def under(path, roots):
        return any(path == r or path.startswith(r + "/") for r in roots)

    pts, tris, meta = [], [], []
    v0 = t0 = 0
    for prim in Usd.PrimRange(root, Usd.TraverseInstanceProxies()):
        if not prim.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(prim)
        counts = mesh.GetFaceVertexCountsAttr().Get()
        indices = mesh.GetFaceVertexIndicesAttr().Get()
        points = mesh.GetPointsAttr().Get()
        if not counts or not indices or not points:
            continue
        tri = fan(counts, indices)
        if tri is None:
            continue
        M = np.array(xform.GetLocalToWorldTransform(prim), dtype=np.float64)
        p = np.asarray(points, dtype=np.float64)
        world = (np.c_[p, np.ones(len(p))] @ M)[:, :3]
        if np.linalg.det(M[:3, :3]) < 0:
            tri = tri[:, [0, 2, 1]]
        path = str(prim.GetPath())
        rgb, metal, mat = colour_of(prim)
        if "VPPS_40INTERIOR" in path:
            kind = "beam"
        elif under(path, conn_paths):
            kind = "connector"
        elif under(path, clip_paths):
            kind = "clip"
        elif mat == "Braid":
            kind = "wire"
        else:
            kind = "part"
        pts.append(world)
        tris.append(tri.astype(np.int32))
        meta.append({"v": v0, "nv": len(world), "t": t0, "nt": len(tri), "rgb": rgb,
                     "metal": bool(metal), "mat": mat, "kind": kind})
        v0 += len(world)
        t0 += len(tri)

    allp = np.concatenate(pts)
    centre = (allp.min(0) + allp.max(0)) / 2
    np.savez_compressed(os.path.join(args.out, "raw.npz"),
                        pts=(allp - centre).astype(np.float32), tri=np.concatenate(tris))

    cards = []
    i = 0
    for tag_id, part in SHEET:
        if part in ABSENT:
            continue
        if i >= len(clips) or clips[i][2] != part:
            raise SystemExit(f"beam order broke at tag {tag_id}: expected {part}, "
                             f"next clip is {clips[i][2] if i < len(clips) else 'none'}")
        _, _, _, c, top, _ = clips[i]
        i += 1
        at = [c[0] - centre[0], c[1] - centre[1], top - centre[2] + 0.002]
        cards.append({"order": tag_id, "at": [round(float(v), 5) for v in at],
                      "size": list(CARD), "part": part, "host": "clip"})
    if i != len(clips):
        raise SystemExit(f"{len(clips) - i} clip solids left over after the sheet")
    for tag_id, wh in FIXED:
        prim = stage.GetPrimAtPath(by_id[wh]["prim_path"])
        bound = box_cache.ComputeWorldBound(prim).ComputeAlignedRange()
        lo, hi = bound.GetMin(), bound.GetMax()
        c = [(lo[k] + hi[k]) / 2 for k in range(3)]
        at = [c[0] - centre[0], c[1] - centre[1], hi[2] - centre[2] + 0.004]
        cards.append({"order": tag_id, "at": [round(float(v), 5) for v in at],
                      "size": list(CARD), "part": wh, "host": "connector"})
    connectors = [{
        "id": row["wh_id"],
        "at": [round(row["center_m"][k] - float(centre[k]), 5) for k in range(3)],
        "sizeMm": row["size_mm"],
    } for row in binding["placed"]]
    with open(os.path.join(args.out, "raw.json"), "w") as f:
        json.dump({"meshes": meta, "cards": cards, "connectors": connectors,
                   "notPlaced": [r if isinstance(r, str) else r.get("wh_id") for r in binding.get("not_placed", [])]}, f)
    kinds = {k: sum(m["nt"] for m in meta if m["kind"] == k) for k in KINDS}
    print(f"solids {len(meta)}  faces {t0}  by kind {kinds}  cards {len(cards)}")


# ------------------------------------------------------------ the reduction

def weld(p, t):
    """One vertex per place. CAD tessellation repeats them along every seam."""
    q = np.round(p.astype(np.float64) / 2e-5).astype(np.int64)
    uniq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    t = inv[t]
    keep = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
    t = t[keep]
    if not len(t):
        return None, None
    used, back = np.unique(t, return_inverse=True)
    pos = np.zeros((len(uniq), 3), np.float64)
    pos[inv] = p
    return pos[used].astype(np.float32), back.reshape(-1, 3).astype(np.int32)


def budget(kind, n, extent):
    """Faces one solid may keep. The beam and the harness stay at the CAD tessellation."""
    return n


def reduce_solid(p, t, keep):
    import fast_simplification
    n = len(t)
    if keep >= n * 0.97:
        return p, t
    p2, t2 = fast_simplification.simplify(p, t, target_count=int(keep), agg=5)
    p2 = np.asarray(p2, dtype=np.float32)
    t2 = np.asarray(t2, dtype=np.int32)
    if not len(t2):
        return p, t
    return p2, t2


def write_glb(path, layers):
    """`layers` is {name: [(pos, idx, rgb, metal)]}. One node a layer, one mesh a colour."""
    blob = bytearray()
    views, accessors, meshes, materials, nodes = [], [], [], [], []
    top = []
    for name, groups in layers.items():
        kids = []
        for pos, idx, rgb, metal in groups:
            small = len(pos) < 65536
            pos_b = pos.astype(np.float32).tobytes()
            idx_b = idx.astype(np.uint16 if small else np.uint32).tobytes()
            v0 = len(views)
            for byt, target in ((pos_b, 34962), (idx_b, 34963)):
                views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(byt), "target": target})
                blob += byt
                blob += b"\x00" * ((4 - len(blob) % 4) % 4)
            a0 = len(accessors)
            accessors.append({"bufferView": v0, "componentType": 5126, "count": len(pos), "type": "VEC3",
                              "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
            accessors.append({"bufferView": v0 + 1, "componentType": 5123 if small else 5125,
                              "count": int(idx.size), "type": "SCALAR"})
            materials.append({
                "pbrMetallicRoughness": {
                    "baseColorFactor": [float(rgb[0]), float(rgb[1]), float(rgb[2]), 1],
                    "metallicFactor": 0.6 if metal else 0.0,
                    "roughnessFactor": 0.45 if metal else 0.62,
                },
                "doubleSided": True,
            })
            meshes.append({"primitives": [{"attributes": {"POSITION": a0}, "indices": a0 + 1,
                                           "material": len(materials) - 1}]})
            nodes.append({"mesh": len(meshes) - 1})
            kids.append(len(nodes) - 1)
        nodes.append({"name": name, "children": kids})
        top.append(len(nodes) - 1)
    gltf = {
        "asset": {"version": "2.0", "generator": "export-harness-assembly.py"},
        "scene": 0, "scenes": [{"nodes": top}], "nodes": nodes, "meshes": meshes,
        "materials": materials, "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    out = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<I4s", len(js), b"JSON") + js
    out += struct.pack("<I4s", len(blob), b"BIN\x00") + bytes(blob)
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


def build(args):
    raw = json.load(open(os.path.join(args.build, "raw.json")))
    data = np.load(os.path.join(args.build, "raw.npz"))
    pts, tri = data["pts"], data["tri"]
    os.makedirs(args.out, exist_ok=True)

    buckets = {}
    faces_in = faces_out = 0
    per_kind = {k: [0, 0] for k in KINDS}
    for m in raw["meshes"]:
        p = pts[m["v"]:m["v"] + m["nv"]]
        t = tri[m["t"]:m["t"] + m["nt"]]
        faces_in += len(t)
        p, t = weld(p, t)
        if p is None:
            continue
        extent = float((p.max(0) - p.min(0)).max())
        p, t = reduce_solid(p, t, budget(m["kind"], len(t), extent))
        faces_out += len(t)
        per_kind[m["kind"]][0] += m["nt"]
        per_kind[m["kind"]][1] += len(t)
        # Wires are their own layer so the page can shade them round.
        layer = m["kind"] if m["kind"] in ("beam", "wire") else "harness"
        key = (layer, tuple(round(c, 3) for c in m["rgb"]), m["metal"])
        buckets.setdefault(key, []).append((p, t))

    layers = {"harness": [], "wire": [], "beam": []}
    for (layer, rgb, metal), parts in sorted(buckets.items(), key=lambda kv: str(kv[0])):
        # Split a colour that outgrows a 16-bit index, so most of the file is short indices.
        chunk, count = [], 0
        def flush():
            off = np.cumsum([0] + [len(p) for p, _ in chunk[:-1]])
            layers[layer].append((np.concatenate([p for p, _ in chunk]),
                                  np.concatenate([t + o for (_, t), o in zip(chunk, off)]), rgb, metal))
        for p, t in parts:
            if chunk and count + len(p) >= 65536:
                flush()
                chunk, count = [], 0
            chunk.append((p, t))
            count += len(p)
        if chunk:
            flush()
    size = write_glb(os.path.join(args.out, "harness.glb"), layers)

    # The printed tags the glasses read, on the clips they were matched to.
    by_order = {c["order"]: c for c in raw["cards"] if c["host"] == "clip"}
    tag_at = {tag: by_order[order]["at"] for tag, _, _, _, _, order in BOUND}
    for a, b, want, src in SPACING:
        got = float(np.linalg.norm(np.subtract(tag_at[a], tag_at[b]))) * 1000
        if abs(got - want) > want * 0.15:
            raise SystemExit(f"tags {a} and {b}: CAD {got:.0f} mm, measured {want} mm ({src})")
        print(f"  tags {a}-{b}: CAD {got:.0f} mm, measured {want} mm  {src}")
    clip_cards = [c for c in raw["cards"] if c["host"] == "clip"]
    where = {c["id"]: c["at"] for c in raw["connectors"]}
    for tag, wh in END_CLIP:
        nearest = min(clip_cards, key=lambda c: float(np.linalg.norm(np.subtract(c["at"], where[wh]))))
        if nearest["at"] != tag_at[tag]:
            raise SystemExit(f"tag {tag}: its clip is no longer the one nearest {wh}")
        print(f"  tag {tag}: the clip nearest {wh}, "
              f"{float(np.linalg.norm(np.subtract(nearest['at'], where[wh]))) * 1000:.0f} mm")
    bound_orders = {order: (tag, rid, zone, slot, words) for tag, rid, zone, slot, words, order in BOUND}
    # Every card shows a tag. A matched clip shows its printed one. The clip
    # the Spark sheet had given that number takes the matched clip's old one,
    # so each number is still on one card only.
    freed = {tag: order for tag, _, _, _, _, order in BOUND}
    tags = []
    for c in raw["cards"]:
        row = {"order": c["order"], "at": c["at"], "size": c["size"], "part": c["part"], "host": c["host"]}
        row["shown"] = freed.get(c["order"], c["order"])
        if c["host"] == "connector":
            row["tag"] = row["shown"] = c["order"]  # the fixed cards carry the registry's own numbers
        elif c["order"] in bound_orders:
            tag, rid, zone, slot, words = bound_orders[c["order"]]
            row.update({"tag": tag, "shown": tag, "rosebud": rid, "zone": zone, "pillar": slot,
                        "words": words, "setBy": "hand"})
        tags.append(row)
    shown = [r["shown"] for r in tags]
    if len(set(shown)) != len(shown):
        raise SystemExit("two cards show the same tag")
    tags.sort(key=lambda r: r["order"])

    manifest = {
        "units": "m", "up": [0, 0, 1], "driver": "negative Y", "rear": "positive X",
        "origin": "centred on the assembly",
        "facesIn": int(faces_in), "faces": int(faces_out),
        "layers": ["harness", "wire", "beam"],
        "note": (
            "The harness, its connectors and the cross car beam are the Spark CAD, "
            "in the housing colours from the bench."
        ),
        "tagNotes": {
            "printed": (
                "Every clip carries a tag. The printed ones sit on the clips they were matched to: "
                "driver side A pillar 1 and 2, passenger side A pillar 2, 3, 4 and 6, and the four fixed "
                "cards by a named connector. The match was set by hand, from the spacing between the tags "
                "in the recordings. The other clips keep a number from the Spark sheet, which is the order "
                "along the beam and is not the printed numbering."
            ),
            "spark": (
                "The Spark sheet: a card on every clip in the order along the beam, tag 8 at the "
                "driver end through tag 73 at the passenger end. Tags 28 and 39 are not in this "
                "extract. This order is not the printed numbering."
            ),
        },
        "zones": ZONES,
        "tags": tags,
        "connectors": raw["connectors"],
    }
    with open(os.path.join(args.out, "harness.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"faces {faces_in} -> {faces_out}  glb {size}")
    for k, (a, b) in per_kind.items():
        print(f"  {k:9} {a:>8} -> {b:>7}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true")
    ap.add_argument("--stage")
    ap.add_argument("--binding")
    ap.add_argument("--build", metavar="RAW_DIR")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    if args.dump:
        dump(args)
    elif args.build:
        build(args)
    else:
        ap.error("--dump or --build")


if __name__ == "__main__":
    main()
