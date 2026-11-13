#!/usr/bin/env python3
"""Cut a 3D model and the six CAD views of each radio and gateway connector
out of the harness CAD, for the Emotiv station page.

    python tools/emotiv-replay/export-connector-models.py \
        --usd   <dir>/A2LL.usdc \
        --sheet <dir>/connector_view_sheet.png

Both files are on the render machine, and a copy of each is in
AldoOmnia/egogs1_cv on `docs/daf27bz01-dv012-tdp` under docs/assets/.

`A2LL.usdc` is the harness as converted from JT. Each connector is one part
under the master harness, and the part's name starts with its GM part number
and revision. This script finds a connector ID's part by that number, the one
the connector workbook gives for the ID.

Two radio IDs have no part number in the workbook and no solid of their own
on the beam: WH-EZ4-04 and WH-EZ4-06. The connector log has them confirmed on
the bench and unresolved against CAD. For the page they are drawn with the
shell of the nearest connector that does have a solid, in their own head
colour. `STAND_IN` says whose shell, and the manifest says so beside each
one. Add an ID there to draw any other connector the CAD does not have.

The CAD carries no colours. Each model is written in one colour, the colour
of that connector's head on the bench, and the page draws it that way.

`connector_view_sheet.png` is the render machine's sheet: one row per
connector, seven 200 px pictures. The six flat views are cut from it. It has
no index a program can read, so `SHEET_ROWS` is its row order, read off it.

Writes eval-lab/public/assets/emotiv/connectors/<ID>/model.glb and
<view>.jpg, and adds to connectors.json beside them. Needs usd-core, trimesh,
numpy, pillow, scipy, and fast-simplification.
"""
import argparse
import json
import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "eval-lab", "public", "assets", "emotiv", "connectors"))

HARNESS = (
    "/A2LL/A2LL/tn__AMU66248002MAINSTREAMMODULEView_rW0Sr8c1V4p1"
    "/tn__AMU66249001VPPS_80ELECTRICALFUNCTIONView_xf0Tc0oBw1e5e2"
    "/tn__AMU66251100VPPS_806POWERSIGNALDISTRIBUTIONView_Zm0V0i0gDd2X6f1V1S"
    "/tn__BRH117740010029IAIPWRGHARNESSA2LLDMMView_yf0NV0d0xBy1m5Ic0e0V1y0"
)

# Connector ID -> (GM part number, which copy of it in the harness). From the
# connector workbook. The gateway's two are the same part, placed twice.
BY_WORKBOOK = {
    "WH-EZ4-01": ("13534974", 0),
    "WH-EZ4-05": ("13551156", 0),
    "WH-EZ4-07": ("13551197", 0),
    "WH-EZ4-08": ("13563021", 0),
    "WH-EZ4-09": ("13534971", 0),
    "WH-EZ4-10": ("13544788", 0),
    "WH-EZ4-11": ("13546790", 0),
    "WH-EZ5-01-A": ("13528149", 0),
    "WH-EZ5-01-B": ("13528149", 1),
}

# IDs with no part number and no solid in the CAD -> whose shell to draw them
# with. A stand-in for the picture only: it is not that connector's part.
STAND_IN = {
    "WH-EZ4-06": {
        "shell": "WH-EZ4-05",
        "basis": (
            "No solid of its own in the harness CAD. The connector log has this "
            "one confirmed on the bench and unresolved against CAD, with no GM "
            "part. It is drawn with the shell of WH-EZ4-05, the black Molex of "
            "the same family, in tan."
        ),
    },
    "WH-EZ4-04": {
        "shell": "WH-EZ4-08",
        "basis": (
            "No solid of its own in the harness CAD, and no GM part in the "
            "workbook. It is drawn with the shell of WH-EZ4-08, the black "
            "four-cavity coax shell beside it on the radio, in cream."
        ),
    },
}

# The colour of each connector's head on the bench.
HEAD = {
    "WH-EZ4-01": ("light grey", "#B4B8BD"),
    "WH-EZ4-04": ("cream", "#E6DEC8"),
    "WH-EZ4-05": ("black", "#2B2D31"),
    "WH-EZ4-06": ("tan", "#B58E63"),
    "WH-EZ4-07": ("pale grey", "#C6C9CD"),
    "WH-EZ4-08": ("black", "#2B2D31"),
    "WH-EZ4-09": ("black", "#2B2D31"),
    "WH-EZ4-10": ("black", "#2B2D31"),
    "WH-EZ4-11": ("black", "#2B2D31"),
    "WH-EZ5-01-A": ("light grey", "#B4B8BD"),
    "WH-EZ5-01-B": ("black", "#2B2D31"),
}

# The view sheet's rows, top to bottom.
SHEET_ROWS = [
    "Power for IP", "WH-EC-05#1", "WH-EC-05#2", "WH-EC-15", "WH-EC-34", "WH-EC-51",
    "WH-EZ1-01", "WH-EZ1-02", "WH-EZ2-01", "WH-EZ2-02", "WH-EZ3-01 #1",
    "WH-EZ4-01", "WH-EZ4-03", "WH-EZ4-05", "WH-EZ4-07", "WH-EZ4-08", "WH-EZ4-09",
    "WH-EZ4-10", "WH-EZ4-11", "WH-EZ5-01-A", "WH-EZ5-01-B",
    "WH-EZ7-01", "WH-EZ8-01", "WH-EZ10-01", "WH-EZ10-02", "WH-EZ11-01", "WH-EZ11-02",
    "WH-EZ12-01", "WH-EZ14-01", "WH-EZ15-01", "WH-EZ16-01", "WH-EZ17-01", "WH-EZ17-01-B",
    "WH-EZ18-01", "WH-EZ18-02", "WH-EZ18-03", "WH-EZ19-01", "WH-EZ21-01", "WH-EZ21-02",
    "WH-EZ23-01", "WH-EZ24-01", "WH-EZ25-01", "WH-EZ26-01", "WH-EZ27-01",
    "WH-EZ28-01", "WH-EZ28-02", "WH-EZ28-03", "WH-EZ28-04", "WH-EZ29-01", "WH-EZ30-01",
]
# What the sheet says of the one row the workbook did not have.
SHEET_ONLY = {
    "WH-EZ4-10": {
        "label": "Radio bracket, single cavity. Black housing, purple side insert, red latch.",
        "gmPart": "13544788",
        "revision": "001",
        "supplier": "ROSENBERGER - AMZW170-00A - CONNECTOR ASM-COAX CBL",
    },
}
FLAT_VIEWS = ["front", "back", "left", "right", "top", "bottom"]
MAX_TRIANGLES = 14000


def harness_parts(stage):
    """GM part number -> the harness parts with that number, in file order."""
    from pxr import Usd

    harness = stage.GetPrimAtPath(HARNESS)
    if not harness.IsValid():
        raise SystemExit("the harness is not at the path this script expects")
    master = [c for c in harness.GetChildren() if "MASTER" in c.GetName()]
    if not master:
        raise SystemExit("no master harness under the wire harness")
    parts = {}
    for prim in master[0].GetChildren():
        m = re.match(r"tn__(\d{8})(\d{3})", prim.GetName())
        if m:
            parts.setdefault(m.group(1), []).append(prim)
    return parts


def part_mesh(prim):
    """Every mesh under a part as one triangle mesh, in millimetres, centred."""
    import trimesh
    from pxr import Usd, UsdGeom

    now = Usd.TimeCode.Default()
    to_part = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(now).GetInverse()
    pieces = []
    for p in Usd.PrimRange(prim, Usd.TraverseInstanceProxies()):
        if not p.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(p)
        pts = np.array(mesh.GetPointsAttr().Get(), dtype=np.float64)
        m = np.array(UsdGeom.Xformable(p).ComputeLocalToWorldTransform(now) * to_part)
        pts = (np.c_[pts, np.ones(len(pts))] @ m)[:, :3]
        counts = np.array(mesh.GetFaceVertexCountsAttr().Get())
        idx = np.array(mesh.GetFaceVertexIndicesAttr().Get())
        if (counts == 3).all():
            tris = idx.reshape(-1, 3)
        else:
            tris, o = [], 0
            for c in counts:
                for k in range(1, c - 1):
                    tris.append((idx[o], idx[o + k], idx[o + k + 1]))
                o += c
            tris = np.array(tris)
        pieces.append(trimesh.Trimesh(pts, tris, process=False))
    if not pieces:
        return None
    whole = trimesh.util.concatenate(pieces)
    whole.merge_vertices()
    # A part is stored in millimetres or in metres depending on how the
    # converter instanced it. No connector here is a metre long.
    if whole.extents.max() < 1.0:
        whole.apply_scale(1000.0)
    elif whole.extents.max() > 1000.0:
        whole.apply_scale(0.001)
    whole.apply_translation(-whole.bounds.mean(axis=0))
    if len(whole.faces) > MAX_TRIANGLES:
        import fast_simplification

        v, f = fast_simplification.simplify(
            np.asarray(whole.vertices, dtype=np.float32), np.asarray(whole.faces),
            target_count=MAX_TRIANGLES,
        )
        whole = trimesh.Trimesh(v, f, process=False)
    return whole


def write_glb(mesh, colour, path):
    import trimesh

    rgb = [int(colour[i:i + 2], 16) for i in (1, 3, 5)]
    mesh.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(
            baseColorFactor=rgb + [255], metallicFactor=0.0, roughnessFactor=0.62,
        )
    )
    with open(path, "wb") as f:
        f.write(trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh), include_normals=False))


def sheet_grid(img):
    """Where the sheet's picture rows and columns are, found from its tiles."""
    px = img.load()
    w, h = img.size
    grey = lambda p: abs(p[0] - p[1]) < 6 and abs(p[1] - p[2]) < 6 and 100 < p[0] < 150  # noqa: E731
    rows, y = [], 0
    while y < h:
        if grey(px[420, y]):
            y0 = y
            while y < h and grey(px[420, y]):
                y += 1
            if y - y0 > 100:
                rows.append((y0, y))
        y += 1
    paper = px[5, 5]
    cols, x, yy = [], 0, rows[0][0] + 3
    while x < w:
        if abs(px[x, yy][0] - paper[0]) > 20:
            x0 = x
            while x < w and abs(px[x, yy][0] - paper[0]) > 20:
                x += 1
            if x - x0 > 100:
                cols.append((x0, x))
        x += 1
    return rows, cols


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--usd", required=True)
    ap.add_argument("--sheet")
    args = ap.parse_args()

    from pxr import Usd

    manifest_path = os.path.join(OUT, "connectors.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    connectors = manifest["connectors"]

    stage = Usd.Stage.Open(os.path.expanduser(args.usd))
    parts = harness_parts(stage)
    wanted = {cid: (ref, None) for cid, ref in BY_WORKBOOK.items()}
    wanted.update({cid: (BY_WORKBOOK[spec["shell"]], spec) for cid, spec in STAND_IN.items()})
    for cid, ((gm, copy), spec) in sorted(wanted.items()):
        found = parts.get(gm, [])
        if copy >= len(found):
            print(f"{cid}: GM {gm} copy {copy} is not in the harness, skipped")
            continue
        mesh = part_mesh(found[copy])
        if mesh is None:
            print(f"{cid}: GM {gm} has no mesh, skipped")
            continue
        entry = connectors.setdefault(cid, {"label": "", "views": []})
        entry.update(SHEET_ONLY.get(cid, {}))
        os.makedirs(os.path.join(OUT, cid), exist_ok=True)
        name, colour = HEAD[cid]
        write_glb(mesh, colour, os.path.join(OUT, cid, "model.glb"))
        entry["model"] = {
            "file": "model.glb",
            "head": name,
            "colour": colour,
            "sizeMm": [round(float(x), 1) for x in mesh.extents],
            "triangles": int(len(mesh.faces)),
        }
        if spec:
            entry["model"]["standIn"] = spec["shell"]
            entry["model"]["basis"] = spec["basis"]
            entry["model"]["gmPart"] = gm
            entry["model"]["supplier"] = connectors.get(spec["shell"], {}).get("supplier", "")
        print(f"{cid}: GM {gm}, {len(mesh.faces)} triangles, "
              f"{' x '.join(str(x) for x in entry['model']['sizeMm'])} mm, {name}"
              f"{' (the shell of ' + spec['shell'] + ')' if spec else ''}")

    if args.sheet:
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = None
        img = Image.open(os.path.expanduser(args.sheet)).convert("RGB")
        rows, cols = sheet_grid(img)
        if len(rows) != len(SHEET_ROWS) or len(cols) != 7:
            raise SystemExit(f"the sheet has {len(rows)} rows and {len(cols)} columns, not the "
                             f"{len(SHEET_ROWS)} by 7 this script knows")
        for cid in sorted(connectors):
            if cid not in SHEET_ROWS:
                continue
            y0, y1 = rows[SHEET_ROWS.index(cid)]
            for view, (x0, x1) in zip(FLAT_VIEWS, cols):
                img.crop((x0, y0, x1, y1)).save(os.path.join(OUT, cid, f"{view}.jpg"), quality=90)
            stale = os.path.join(OUT, cid, "3d.jpg")
            if os.path.exists(stale):
                os.remove(stale)
            connectors[cid]["views"] = list(FLAT_VIEWS)
            connectors[cid].pop("noSolid", None)
        manifest["views"] = list(FLAT_VIEWS)
        manifest["sheet"] = os.path.basename(args.sheet)
        manifest["note"] = ("Flat views cut from the render machine's connector sheet, 200 px each. "
                            "Models cut from the harness CAD, one colour each: the head colour on the bench.")
    manifest["geometry"] = os.path.basename(args.usd)

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    have = sum(1 for c in connectors.values() if c.get("model"))
    print(f"{have} of {len(connectors)} connectors have a model -> {OUT}")


if __name__ == "__main__":
    main()
