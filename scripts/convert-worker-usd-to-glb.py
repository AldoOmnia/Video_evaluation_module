#!/usr/bin/env python3
"""Convert NVIDIA Omniverse Worker (MDL + Reallusion skeleton) USD → textured GLB.

Usage (repo root):
  .venv-usd/bin/python scripts/convert-worker-usd-to-glb.py

Embeds diffuse / normal / roughness / opacity maps from Worker/Materials/Textures/.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from pxr import Sdf, Usd, UsdShade, UsdSkel, UsdUtils

REPO = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = REPO / "eval-lab/public/assets/Worker/Props/Worker.usd"
DEFAULT_OUTPUT = REPO / "eval-lab/public/assets/operator-omniverse.glb"
USD2GLTF = REPO / ".venv-usd/bin/usd2gltf"
USD_SKEL = REPO / ".venv-usd/lib/python3.14/site-packages/usd2gltf/converters/usd_skel.py"
USD_MAT = REPO / ".venv-usd/lib/python3.14/site-packages/usd2gltf/converters/usd_material.py"

MDL_TEXTURE_INPUTS = {
    "diffuseColor": ("diffuse_texture", "rgb", "sRGB"),
    "normal": ("normalmap_texture", "rgb", "raw"),
    "roughness": ("reflectionroughness_texture", "r", "raw"),
    "opacity": ("opacity_texture", "a", "raw"),
}


def ensure_usd2gltf_patches() -> None:
    skel = USD_SKEL.read_text()
    mat = USD_MAT.read_text()
    if "if meshJoints is None:" not in skel:
        raise SystemExit(f"Missing skeleton patch in {USD_SKEL}")
    if "mat_path = usd_material.GetPrim().GetPrimPath()" not in mat:
        raise SystemExit(f"Missing material patch in {USD_MAT}")


def find_mdl_shader(material: UsdShade.Material) -> UsdShade.Shader | None:
    for child in material.GetPrim().GetChildren():
        if child.IsA(UsdShade.Shader):
            return UsdShade.Shader(child)
    return None


def resolve_asset_path(asset: Sdf.AssetPath | None) -> str | None:
    if not asset or not asset.path:
        return None
    resolved = asset.resolvedPath or asset.path
    if resolved and Path(resolved).is_file():
        return resolved
    return None


def mdl_texture_path(shader: UsdShade.Shader, input_name: str) -> str | None:
    inp = shader.GetInput(input_name)
    if not inp:
        return None
    val = inp.Get()
    if isinstance(val, Sdf.AssetPath):
        return resolve_asset_path(val)
    return None


def define_st_reader(stage: Usd.Stage, path: Sdf.Path) -> UsdShade.Shader:
    reader = UsdShade.Shader.Define(stage, path)
    reader.CreateIdAttr("UsdPrimvarReader_float2")
    reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
    return reader


def define_uv_texture(
    stage: Usd.Stage,
    path: Sdf.Path,
    file_path: str,
    color_space: str,
    output_name: str,
) -> UsdShade.Shader:
    tex = UsdShade.Shader.Define(stage, path)
    tex.CreateIdAttr("UsdUVTexture")
    tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(file_path))
    tex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set(color_space)
    tex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
    tex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")

    reader = define_st_reader(stage, path.AppendChild("stReader"))
    st_out = reader.CreateOutput("result", Sdf.ValueTypeNames.Float2)
    tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(st_out)
    return tex


def replace_material_with_preview(stage: Usd.Stage, material: UsdShade.Material) -> bool:
    mdl = find_mdl_shader(material)
    if not mdl:
        return False

    mat_path = material.GetPath()
    preview_path = mat_path.AppendChild("PreviewSurface")
    preview = UsdShade.Shader.Define(stage, preview_path)
    preview.CreateIdAttr("UsdPreviewSurface")
    preview.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.04)
    preview.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.72)

    has_maps = False
    for preview_input, (mdl_input, output_channel, color_space) in MDL_TEXTURE_INPUTS.items():
        file_path = mdl_texture_path(mdl, mdl_input)
        if not file_path:
            continue
        tex = define_uv_texture(
            stage,
            mat_path.AppendChild(f"Tex_{preview_input}"),
            file_path,
            color_space,
            output_channel,
        )
        tex_out = tex.CreateOutput(output_channel, Sdf.ValueTypeNames.Float3 if output_channel == "rgb" else Sdf.ValueTypeNames.Float)
        preview.CreateInput(preview_input, tex_out.GetTypeName()).ConnectToSource(tex_out)
        has_maps = True

    if not has_maps:
        preview.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set((0.78, 0.72, 0.66))

    material.CreateSurfaceOutput().ConnectToSource(preview.ConnectableAPI(), "surface")
    return has_maps


def prepare_stage(input_usd: Path, flat_usd: Path) -> None:
    stage = Usd.Stage.Open(str(input_usd))
    if not stage:
        raise SystemExit(f"Could not open {input_usd}")

    UsdUtils.FlattenLayerStack(stage).Export(str(flat_usd))
    flat = Usd.Stage.Open(str(flat_usd))

    textured = 0
    fallback = 0
    for prim in flat.Traverse():
        if prim.IsA(UsdSkel.Skeleton):
            skel = UsdSkel.Skeleton(prim)
            joints = skel.GetJointsAttr().Get() or []
            if not skel.GetJointNamesAttr().Get() and joints:
                skel.GetJointNamesAttr().Set(joints)
        if prim.IsA(UsdShade.Material):
            if replace_material_with_preview(flat, UsdShade.Material(prim)):
                textured += 1
            else:
                fallback += 1

    flat.GetRootLayer().Save()
    print(f"Flattened {input_usd.name} → {flat_usd} ({textured} textured, {fallback} fallback materials)")


def run_usd2gltf(flat_usd: Path, output_glb: Path) -> None:
    if not USD2GLTF.is_file():
        raise SystemExit(f"usd2gltf not found at {USD2GLTF}")
    cmd = [str(USD2GLTF), "-i", str(flat_usd), "-o", str(output_glb)]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    verify_glb_buffers(output_glb)


def verify_glb_buffers(glb_path: Path) -> None:
    import json
    import struct

    data = glb_path.read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + json_len])
    buffers = gltf.get("buffers", [])
    bad = [
        i
        for i, bv in enumerate(gltf.get("bufferViews", []))
        if bv.get("buffer", 0) >= len(buffers)
    ]
    if bad:
        raise SystemExit(f"Invalid GLB: bufferViews {bad} reference missing buffers (of {len(buffers)})")
    print(f"GLB OK — {len(buffers)} buffer(s), {len(gltf.get('images', []))} images")


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert Omniverse Worker USD to textured operator-omniverse.glb")
    parser.add_argument("-i", "--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--flat-usd", type=Path, default=Path("/tmp/worker-full-flat.usd"))
    args = parser.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"Input USD not found: {args.input}")

    ensure_usd2gltf_patches()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    prepare_stage(args.input, args.flat_usd)
    run_usd2gltf(args.flat_usd, args.output)
    size_mb = args.output.stat().st_size / (1024 * 1024)
    print(f"Wrote {args.output} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
