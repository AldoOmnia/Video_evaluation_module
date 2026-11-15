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

`connector_view_sheet.png` is the render machine's sheet: one row per
connector, seven 200 px pictures. The six flat views are cut from it. It has
no index a program can read, so `SHEET_ROWS` is its row order, read off it.

The colours of a model come from that sheet too. A connector's head is the
colour it is on the bench, from `HEAD`. Its other parts (a red latch, a
purple lock, gold contacts, a black boot) are the colours the sheet's views
show them in. The CAD's own colours are no use for this: in it a black shell
is cream and a purple lock is red. What the CAD does keep, for some
connectors, is the bodies apart: the shell, the latch, each contact. Where it
does, a body is one colour, the one most of what the views show of it. Where
a connector is a single body in the CAD, each of its triangles takes the
colour the views show at that spot. Without `--sheet` every model is written
in its head colour alone.

One piece is on neither. WH-EZ4-11 has a red lock tab on the bench, the sheet
draws the whole connector black, and the CAD has the tab fused into the
shell. `BY_HAND` says where it is, and the manifest says it was set by hand.

Writes eval-lab/public/assets/emotiv/connectors/<ID>/model.glb and
<view>.jpg, and adds to connectors.json beside them. Needs usd-core, numpy,
pillow, scipy, and fast-simplification.
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

# The colours the sheet shows a connector's other parts in, and the span of
# hue, in degrees, that counts as each. Each colour is that hue's pixels on
# the radio rows of the sheet: their mean hue, the saturation of their upper
# quarter, and their median brightness (gold's upper quarter: its pixels sit
# down dark cavities).
ACCENT = {
    "red": ("#E06F69", 338, 22),
    "purple": ("#B567C9", 262, 325),
    "gold": ("#C4B16C", 30, 68),
}

# Connectors whose boot is another colour than the head. Where the boot
# starts is read off the sheet: the place along the part where its side views
# go from dark to light.
BOOT = {
    "WH-EZ4-07": ("black boot", "#2B2D31"),
}

# Pieces the sheet does not show and the CAD does not keep apart, placed by
# hand: the accent, and a box around the piece in mm from the middle of the
# part, as the lowest and highest x, y and z. A triangle with every corner in
# the box is the piece.
#
# WH-EZ4-11's lock tab is red in the workbook's bench photos (CV Training
# Photos, row 49): a red block at the wire end, in the middle of the latch
# side. On the CAD that is the plate standing off the wire end there and the
# stem behind it, as far as the latch arm.
BY_HAND = {
    "WH-EZ4-11": [("red", ((-4.25, 4.25), (4.4, 11.6), (-12.7, -5.1)))],
}

# The sheet's six flat views as cameras on a part in its own axes: the way
# each one looks, and which way is up in its picture. The part sits in the
# middle of its picture with its longest side SHEET_LONG_SIDE_PX long. Found
# by laying each part's outline over its pictures. All nine parts fit.
SHEET_CAMERAS = {
    "front": ((0, 0, -1), (0, 1, 0)),
    "back": ((0, 0, 1), (0, 1, 0)),
    "left": ((1, 0, 0), (0, 1, 0)),
    "right": ((-1, 0, 0), (0, 1, 0)),
    "top": ((0, -1, 0), (0, 0, -1)),
    "bottom": ((0, 1, 0), (0, 0, 1)),
}
SHEET_LONG_SIDE_PX = 108
# Samples across one sheet pixel when a view is laid over a part.
SAMPLES = 4

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
    """A part as one triangle mesh, in millimetres, centred: its points, its
    triangles, and which body each triangle is of.

    A body is a solid the CAD keeps apart inside the part, under one of its
    materials. Copies of one solid, the four contacts of a four-way shell,
    count as one body.
    """
    from pxr import Usd, UsdGeom

    now = Usd.TimeCode.Default()
    to_part = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(now).GetInverse()
    points, tris, body, bodies, at = [], [], [], {}, 0
    for p in Usd.PrimRange(prim, Usd.TraverseInstanceProxies()):
        if not p.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(p)
        pts = np.array(mesh.GetPointsAttr().Get(), dtype=np.float64)
        m = np.array(UsdGeom.Xformable(p).ComputeLocalToWorldTransform(now) * to_part)
        pts = (np.c_[pts, np.ones(len(pts))] @ m)[:, :3]
        counts = np.array(mesh.GetFaceVertexCountsAttr().Get())
        idx = np.array(mesh.GetFaceVertexIndicesAttr().Get())
        fan, of_face, o = [], [], 0
        for face, c in enumerate(counts):
            for k in range(1, c - 1):
                fan.append((idx[o], idx[o + k], idx[o + k + 1]))
                of_face.append(face)
            o += c
        material = np.zeros(len(counts), dtype=int)
        for i, subset in enumerate(UsdGeom.Subset.GetAllGeomSubsets(mesh)):
            material[np.array(subset.GetIndicesAttr().Get(), dtype=int)] = i
        solid = p.GetParent().GetName()
        points.append(pts)
        tris.append(np.array(fan) + at)
        body.append(np.array([bodies.setdefault((solid, i), len(bodies)) for i in material[of_face]]))
        at += len(pts)
    if not points:
        return None
    points, tris, body = np.vstack(points), np.vstack(tris), np.concatenate(body)
    # A part is stored in millimetres or in metres depending on how the
    # converter instanced it. No connector here is a metre long.
    longest = np.ptp(points, axis=0).max()
    if longest < 1.0:
        points = points * 1000.0
    elif longest > 1000.0:
        points = points * 0.001
    points = points - (points.min(axis=0) + points.max(axis=0)) / 2
    points, tris, body = weld(points, tris, body)
    if len(tris) > MAX_TRIANGLES:
        points, tris, body = thin(points, tris, body)
    return points, tris, body


def weld(points, tris, body):
    """The same mesh, with corners that sit in one place sharing one point."""
    _, first, where = np.unique(np.round(points, 4), axis=0, return_index=True, return_inverse=True)
    tris = where.ravel()[tris]
    whole = (tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 2] != tris[:, 0])
    return points[first], tris[whole], body[whole]


def normals(points, tris):
    """Each triangle's normal, and its area."""
    n = np.cross(points[tris[:, 1]] - points[tris[:, 0]], points[tris[:, 2]] - points[tris[:, 0]])
    length = np.linalg.norm(n, axis=1)
    return n / np.maximum(length, 1e-12)[:, None], length / 2


def thin(points, tris, body):
    """The same part in MAX_TRIANGLES triangles, each still of its body."""
    import fast_simplification

    _, _, collapses = fast_simplification.simplify(
        points.astype(np.float32), tris, target_count=MAX_TRIANGLES, return_collapses=True)
    points, thinned, moved_to = fast_simplification.replay_simplification(points.astype(np.float32), tris, collapses)
    # The triangles that are left are the ones no collapse folded shut, in
    # the order they were in.
    was = moved_to[tris]
    left = (was[:, 0] != was[:, 1]) & (was[:, 1] != was[:, 2]) & (was[:, 2] != was[:, 0])
    if left.sum() != len(thinned):
        raise SystemExit("the thinned part does not line up with the part it was thinned from")
    return np.asarray(points, dtype=np.float64), np.asarray(thinned), body[left]


def tile_pixels(tile):
    """What each pixel of a view shows: 0 no colour to speak of, 1 and up an
    accent in ACCENT's order. And how bright it is."""
    t = tile.astype(float)
    hi, lo = t.max(axis=2), t.min(axis=2)
    span = np.maximum(hi - lo, 1e-9)
    r, g, b = t[..., 0], t[..., 1], t[..., 2]
    hue = 60 * np.where(hi == r, ((g - b) / span) % 6, np.where(hi == g, (b - r) / span + 2, (r - g) / span + 4))
    tinted = (span > 28) & (span > 0.22 * hi)
    kind = np.zeros(hi.shape, dtype=int)
    for i, (_, start, end) in enumerate(ACCENT.values(), 1):
        within = (hue >= start) & (hue <= end) if start < end else (hue >= start) | (hue <= end)
        kind[tinted & within] = i
    return kind, hi


def in_front(px, depth, tris, size):
    """The triangle nearest the camera at each sample of a picture, -1 where
    there is none. `px` is each point in samples, `depth` how near it is."""
    faces = np.full((size, size), -1, dtype=np.int64)
    nearest = np.full((size, size), -np.inf)
    for f, (a, b, c) in enumerate(tris):
        (ax, ay), (bx, by), (cx, cy) = px[a], px[b], px[c]
        x0, x1 = max(int(min(ax, bx, cx)), 0), min(int(max(ax, bx, cx)) + 1, size - 1)
        y0, y1 = max(int(min(ay, by, cy)), 0), min(int(max(ay, by, cy)) + 1, size - 1)
        twice = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if x1 < x0 or y1 < y0 or abs(twice) < 1e-12:
            continue
        x, y = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / twice
        wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / twice
        wc = 1 - wa - wb
        near = wa * depth[a] + wb * depth[b] + wc * depth[c]
        was = nearest[y0:y1 + 1, x0:x1 + 1]
        wins = (wa >= 0) & (wb >= 0) & (wc >= 0) & (near > was)
        was[wins] = near[wins]
        faces[y0:y1 + 1, x0:x1 + 1][wins] = f
    return faces


def look(points, tris, tiles):
    """Lay each view of the sheet over the part.

    For each view: the triangle in front at every sample, what the picture
    shows there, how bright, and whether the sample can be trusted. One on
    the part's outline, or on the line between two colours, is a blend and
    cannot.
    """
    from scipy.ndimage import binary_erosion

    scale = SHEET_LONG_SIDE_PX / np.ptp(points, axis=0).max()
    views = {}
    for name, tile in tiles.items():
        toward, up = (np.array(v, dtype=float) for v in SHEET_CAMERAS[name])
        cam = points @ np.array([np.cross(up, -toward), up, -toward]).T
        size = tile.shape[0]
        px = np.c_[size / 2 + cam[:, 0] * scale, size / 2 - cam[:, 1] * scale] * SAMPLES
        faces = in_front(px, cam[:, 2], tris, size * SAMPLES)
        kind, bright = tile_pixels(tile)
        seam = np.zeros(kind.shape, dtype=bool)
        seam[:-1] |= kind[:-1] != kind[1:]
        seam[1:] |= kind[:-1] != kind[1:]
        seam[:, :-1] |= kind[:, :-1] != kind[:, 1:]
        seam[:, 1:] |= kind[:, :-1] != kind[:, 1:]
        big = lambda a: np.repeat(np.repeat(a, SAMPLES, axis=0), SAMPLES, axis=1)  # noqa: E731
        sure = binary_erosion(faces >= 0, iterations=SAMPLES) & ~big(seam)
        views[name] = faces, big(kind), big(bright), sure
    return views


def spread(points, tris, kinds):
    """Give each triangle no view showed (-1) the colour of the ones beside
    it: first across the flat of a face, then round its corners."""
    edges = np.sort(np.r_[tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]], axis=1)
    face = np.tile(np.arange(len(tris)), 3)
    order = np.lexsort((edges[:, 1], edges[:, 0]))
    edges, face = edges[order], face[order]
    shared = (edges[1:] == edges[:-1]).all(axis=1)
    a, b = face[:-1][shared], face[1:][shared]
    n = normals(points, tris)[0]
    flat = (n[a] * n[b]).sum(axis=1) > np.cos(np.radians(30))
    kinds = kinds.copy()
    for a, b in ((a[flat], b[flat]), (a, b)):
        while True:
            to_b = (kinds[a] >= 0) & (kinds[b] < 0)
            to_a = (kinds[b] >= 0) & (kinds[a] < 0)
            if not (to_a.any() or to_b.any()):
                break
            before = kinds.copy()
            kinds[b[to_b]] = before[a[to_b]]
            kinds[a[to_a]] = before[b[to_a]]
    kinds[kinds < 0] = 0
    return kinds


def boot_starts(points, tris, views):
    """Where along its length a part goes from its dark end to its light one,
    in the views that look across it: the axis, the place, and whether the
    dark end is the low one."""
    axis = int(np.ptp(points, axis=0).argmax())
    along = points[tris].mean(axis=1)[:, axis]
    step = 0.5
    places, dark_low = [], []
    for name, (faces, kind, bright, sure) in views.items():
        if SHEET_CAMERAS[name][0][axis]:
            continue
        plain = sure & (kind == 0)
        slot = np.floor((along[faces[plain]] - along.min()) / step).astype(int)
        seen = bright[plain]
        at, level = [], []
        for i in np.unique(slot):
            if (slot == i).sum() >= 40:
                at.append(along.min() + (i + 0.5) * step)
                level.append(np.log(np.median(seen[slot == i])))
        at, level = np.array(at), np.array(level)
        cut = max(range(1, len(at)), key=lambda k: k * (len(at) - k) * (level[:k].mean() - level[k:].mean()) ** 2)
        places.append((at[cut - 1] + at[cut]) / 2)
        dark_low.append(level[:cut].mean() < level[cut:].mean())
    if len(set(dark_low)) != 1:
        raise SystemExit("the views do not agree which end of the part is the boot")
    return axis, float(np.median(places)), dark_low[0]


def paint(points, tris, body, tiles, boot):
    """Which colour each triangle is: 0 the head's, 1 and up an accent in
    ACCENT's order, and one past those the boot's."""
    views = look(points, tris, tiles)
    count = np.zeros((len(tris), 1 + len(ACCENT)))
    for faces, kind, _, sure in views.values():
        for k in range(count.shape[1]):
            count[:, k] += np.bincount(faces[sure & (kind == k)], minlength=len(tris))
    if body.max() > 0:
        # Bodies the CAD keeps apart. Each is the accent the views show most
        # of it in, if that is half of what they show of it or more.
        kinds = np.zeros(len(tris), dtype=int)
        for b in range(body.max() + 1):
            shown = count[body == b].sum(axis=0)
            if shown[1:].max() * 2 >= shown.sum() > 0:
                kinds[body == b] = 1 + shown[1:].argmax()
    else:
        # One body. Each triangle is what the views show most of it in, if
        # they show two pixels of it or more.
        kinds = np.where(count.sum(axis=1) >= 2 * SAMPLES ** 2, count.argmax(axis=1), -1)
        kinds = spread(points, tris, kinds)
    if boot:
        axis, at, dark_low = boot_starts(points, tris, views)
        along = points[tris].mean(axis=1)[:, axis]
        kinds[(kinds == 0) & ((along < at) == dark_low)] = 1 + len(ACCENT)
    return kinds


def linear_rgb(colour):
    """A #RRGGBB colour as glTF stores one: linear light, not the sRGB code."""
    out = []
    for i in (1, 3, 5):
        c = int(colour[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def write_glb(points, tris, kinds, palette, path):
    """One mesh in a .glb. A part of one colour carries it as its material's
    colour. A part of several carries a colour on every corner, and a white
    material under them."""
    import struct

    several = len(set(kinds.tolist())) > 1
    if several:
        # A point where two colours meet becomes one point of each.
        corner = tris * (len(palette) + 1) + kinds[:, None]
        used, index = np.unique(corner, return_inverse=True)
        points = points[used // (len(palette) + 1)]
        colours = np.array([linear_rgb(c) for c in palette])[used % (len(palette) + 1)]
        tris = index.reshape(-1, 3)
    chunks = [tris.astype("<u4").tobytes(), points.astype("<f4").tobytes()]
    accessors = [
        {"bufferView": 0, "componentType": 5125, "count": int(tris.size), "type": "SCALAR"},
        {"bufferView": 1, "componentType": 5126, "count": len(points), "type": "VEC3",
         "min": points.astype("<f4").min(axis=0).tolist(), "max": points.astype("<f4").max(axis=0).tolist()},
    ]
    attributes = {"POSITION": 1}
    if several:
        chunks.append(colours.astype("<f4").tobytes())
        accessors.append({"bufferView": 2, "componentType": 5126, "count": len(points), "type": "VEC3"})
        attributes["COLOR_0"] = 2
    views, at = [], 0
    for i, chunk in enumerate(chunks):
        views.append({"buffer": 0, "byteOffset": at, "byteLength": len(chunk), "target": 34963 if i == 0 else 34962})
        at += len(chunk)
    base = [1.0, 1.0, 1.0] if several else linear_rgb(palette[int(kinds[0])])
    doc = {
        "asset": {"version": "2.0", "generator": "export-connector-models.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": attributes, "indices": 0, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {
            "baseColorFactor": base + [1.0], "metallicFactor": 0.0, "roughnessFactor": 0.62}}],
        "buffers": [{"byteLength": at}], "bufferViews": views, "accessors": accessors,
    }
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    data = b"".join(chunks)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(data)))
        f.write(struct.pack("<I4s", len(text), b"JSON") + text)
        f.write(struct.pack("<I4s", len(data), b"BIN\0") + data)


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

    sheet = None
    if args.sheet:
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = None
        sheet = Image.open(os.path.expanduser(args.sheet)).convert("RGB")
        rows, cols = sheet_grid(sheet)
        if len(rows) != len(SHEET_ROWS) or len(cols) != 7:
            raise SystemExit(f"the sheet has {len(rows)} rows and {len(cols)} columns, not the "
                             f"{len(SHEET_ROWS)} by 7 this script knows")

    def tile(cid, column):
        y0, y1 = rows[SHEET_ROWS.index(cid)]
        x0, x1 = cols[column]
        return sheet.crop((x0, y0, x1, y1))

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
        points, tris, body = mesh
        entry = connectors.setdefault(cid, {"label": "", "views": []})
        entry.update(SHEET_ONLY.get(cid, {}))
        os.makedirs(os.path.join(OUT, cid), exist_ok=True)
        name, colour = HEAD[cid]
        # A stand-in has no row on the sheet. Its other parts are where the
        # sheet shows them on the shell it borrows.
        drawn = spec["shell"] if spec else cid
        boot = BOOT.get(cid)
        kinds = np.zeros(len(tris), dtype=int)
        if sheet is not None and drawn in SHEET_ROWS:
            tiles = {view: np.asarray(tile(drawn, i)) for i, view in enumerate(FLAT_VIEWS)}
            kinds = paint(points, tris, body, tiles, boot)
        placed = []
        for accent, box in BY_HAND.get(cid, []):
            low, high = np.array(box, dtype=float).T
            inside = ((points >= low) & (points <= high)).all(axis=1)
            piece = inside[tris].all(axis=1)
            if not piece.any():
                raise SystemExit(f"{cid}: nothing of the part is where its {accent} piece is set")
            kinds[piece] = 1 + list(ACCENT).index(accent)
            placed.append(accent)
        others = [(accent, code) for accent, (code, _, _) in ACCENT.items()] + [boot or (None, colour)]
        write_glb(points, tris, kinds, [colour] + [code for _, code in others], os.path.join(OUT, cid, "model.glb"))
        entry["model"] = {
            "file": "model.glb",
            "head": name,
            "colour": colour,
            "sizeMm": [round(float(x), 1) for x in np.ptp(points, axis=0)],
            "triangles": int(len(tris)),
        }
        accents = {others[k - 1][0]: others[k - 1][1] for k in sorted(set(kinds.tolist())) if k}
        if accents:
            entry["model"]["accents"] = accents
        if placed:
            entry["model"]["setByHand"] = placed
        if spec:
            entry["model"]["standIn"] = spec["shell"]
            entry["model"]["basis"] = spec["basis"]
            entry["model"]["gmPart"] = gm
            entry["model"]["supplier"] = connectors.get(spec["shell"], {}).get("supplier", "")
        print(f"{cid}: GM {gm}, {len(tris)} triangles, "
              f"{' x '.join(str(x) for x in entry['model']['sizeMm'])} mm, {name}"
              f"{' with ' + ', '.join(accents) if accents else ''}"
              f"{' (' + ', '.join(placed) + ' set by hand)' if placed else ''}"
              f"{' (the shell of ' + spec['shell'] + ')' if spec else ''}")

    if sheet is not None:
        for cid in sorted(connectors):
            if cid not in SHEET_ROWS:
                continue
            for i, view in enumerate(FLAT_VIEWS):
                tile(cid, i).save(os.path.join(OUT, cid, f"{view}.jpg"), quality=90)
            stale = os.path.join(OUT, cid, "3d.jpg")
            if os.path.exists(stale):
                os.remove(stale)
            connectors[cid]["views"] = list(FLAT_VIEWS)
            connectors[cid].pop("noSolid", None)
        manifest["views"] = list(FLAT_VIEWS)
        manifest["sheet"] = os.path.basename(args.sheet)
        manifest["note"] = ("Flat views cut from the render machine's connector sheet, 200 px each. "
                            "Models cut from the harness CAD. The head is its colour on the bench. "
                            "Latches, locks, contacts and boots are the colours that sheet shows them in. "
                            "A piece under setByHand is not on the sheet: its colour is from the bench "
                            "photos and its place on the model was set by hand.")
    manifest["geometry"] = os.path.basename(args.usd)

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    have = sum(1 for c in connectors.values() if c.get("model"))
    print(f"{have} of {len(connectors)} connectors have a model -> {OUT}")


if __name__ == "__main__":
    main()
