#!/usr/bin/env python3
"""Pull the CAD views of the radio and gateway connectors out of the
connector workbook, for the Emotiv station page.

    python3 tools/emotiv-replay/extract-connector-views.py \
        ~/Downloads/A2LL_connector_views.xlsx

The workbook has one row per connector ID with seven pictures (front, back,
left, right, top, bottom, 3D) rendered from the harness CAD, and a second
sheet listing the IDs that have no solid placed and why. The pictures in it
are 150 px thumbnails; the full-size turntables are on the render machine.

Writes eval-lab/public/assets/emotiv/connectors/<ID>/<view>.jpg and
connectors.json beside them. Standard library only.

This writes connectors.json afresh. Run export-connector-models.py after it:
that adds each connector's 3D model to the same file and replaces these
thumbnails with the 200 px views from the render sheet.
"""
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
VIEWS = ["front", "back", "left", "right", "top", "bottom", "3d"]
ZONES = ("WH-EZ4-", "WH-EZ5-")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "eval-lab", "public", "assets", "emotiv", "connectors")


def rows(z, sheet):
    out = []
    root = ET.fromstring(z.read(f"xl/worksheets/{sheet}"))
    for row in root.findall(".//m:row", NS):
        cells = {}
        for c in row.findall("m:c", NS):
            inline = c.find("m:is", NS)
            v = c.find("m:v", NS)
            if inline is not None:
                val = "".join(t.text or "" for t in inline.iter("{%s}t" % NS["m"]))
            else:
                val = v.text if v is not None else ""
            cells["".join(ch for ch in c.get("r") if ch.isalpha())] = (val or "").strip()
        out.append((int(row.get("r")), cells))
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = os.path.expanduser(sys.argv[1])
    z = zipfile.ZipFile(src)
    rels = {
        r.get("Id"): r.get("Target").lstrip("/")
        for r in ET.fromstring(z.read("xl/drawings/_rels/drawing1.xml.rels"))
    }
    pictures = {}
    for anchor in ET.fromstring(z.read("xl/drawings/drawing1.xml")):
        at = anchor.find("xdr:from", NS)
        blip = anchor.find(".//a:blip", NS)
        if at is None or blip is None:
            continue
        key = (int(at.find("xdr:row", NS).text) + 1, int(at.find("xdr:col", NS).text))
        target = rels[blip.get("{%s}embed" % NS["r"])]
        pictures[key] = target if target.startswith("xl/") else "xl/" + target.lstrip("./")

    os.makedirs(OUT, exist_ok=True)
    manifest = {
        "source": os.path.basename(src),
        "note": "150 px views from the connector workbook, rendered from the harness CAD.",
        "views": VIEWS,
        "connectors": {},
    }
    for r, cells in rows(z, "sheet1.xml")[1:]:
        cid = cells.get("A", "")
        if not cid.startswith(ZONES):
            continue
        folder = os.path.join(OUT, cid)
        os.makedirs(folder, exist_ok=True)
        have = []
        for i, view in enumerate(VIEWS):
            name = pictures.get((r, 5 + i))
            if not name:
                continue
            with open(os.path.join(folder, f"{view}.jpg"), "wb") as f:
                f.write(z.read(name))
            have.append(view)
        manifest["connectors"][cid] = {
            "label": cells.get("B", ""),
            "gmPart": cells.get("C", ""),
            "revision": cells.get("D", ""),
            "supplier": cells.get("E", ""),
            "views": have,
        }
    for _, cells in rows(z, "sheet2.xml")[1:]:
        cid = cells.get("A", "")
        if not cid.startswith(ZONES):
            continue
        manifest["connectors"][cid] = {
            "label": cells.get("B", ""),
            "views": [],
            "noSolid": cells.get("C", ""),
        }
    with open(os.path.join(OUT, "connectors.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    placed = sum(1 for c in manifest["connectors"].values() if c["views"])
    print(f"{len(manifest['connectors'])} connectors, {placed} with views -> {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
