# Omniverse catalogue operator (high-poly GLB)

The Spark viewer loads a rigged GLB for the factory operator. The default
`operator-worker.glb` is ~5k triangles (low-poly). For a higher-quality character
from the **NVIDIA Omniverse** content library, export a catalogue asset as GLB
and drop it in this folder.

## NVIDIA Worker (already in repo)

A Reallusion / CC Omniverse **Worker** character lives at:

```
eval-lab/public/assets/Worker/
```

Convert it to GLB for the local viewer (embeds diffuse/normal/roughness/opacity maps):

```bash
# one-time: python3 -m venv .venv-usd && .venv-usd/bin/pip install usd-core usd2gltf
.venv-usd/bin/python scripts/convert-worker-usd-to-glb.py
```

This writes `operator-omniverse.glb` (~72 MB with textures, ~41k tris, 101 bones). Hard-refresh:
`http://localhost:3001/synthetic-pov?zone=1`

The `Worker/` tree is ~230 MB (textures + MDL) — consider `.gitignore` if you
do not want it in git; only `operator-omniverse.glb` is needed at runtime.

## Recommended Omniverse sources

Mount the NVIDIA content library in **Omniverse USD Composer** (or Create):

| Catalogue path | Notes |
|----------------|--------|
| `NVIDIA/Assets/Characters/Reallusion/` | CC digital humans + mocap (best quality) |
| `NVIDIA/Assets/Machinima/NVIDIA_Sol/Characters/` | Sol / Solette hero characters |
| `NVIDIA/Assets/Machinima/Mineways/Characters/Bob.usd` | Lightweight block figure |

Reallusion also publishes free Omniverse-ready USD samples:
https://www.reallusion.com/character-creator/nvidia-omniverse/default.html

## Export to GLB (for Three.js / Spark)

1. Open the character USD in **USD Composer**.
2. Select the character root prim.
3. **File → Export** (or use *Omniverse Asset Converter* / *glTF Exporter* extension).
4. Format: **glTF Binary (.glb)**.
5. Include: mesh, skeleton, at least one **Idle** animation (optional but helps rest pose).
6. Save as:

   ```
   eval-lab/public/assets/operator-omniverse.glb
   ```

7. Hard-refresh local viewer: `http://localhost:3001/synthetic-pov?zone=1`

The viewer tries, in order:

1. `?opGlb=/lab/assets/your-export.glb` (URL override)
2. `operator-omniverse.glb` (this file)
3. `operator-worker.glb` (default low-poly)
4. CDN fallback

## After export — tune in HUD

- **scale / targetHeightM** — Omniverse/CC characters are often ~1.7–1.8 m; adjust
  `targetHeightM` in save pose or use the scale slider (~0.55–0.65× for 1.08 m scene units).
- **op fwd / op side** — per-zone placement (each station can have its own align).
- **yaw** — face the machine (-180° is a common starting point).
- Console log `[splat] operator bone map` — confirms arm/spine bones mapped for animation.

## Rig naming

The viewer maps these bone alias groups automatically:

- Mixamo (`mixamorig*`)
- Poly / generic (`UpperArm.L`, `Hips`, …)
- Reallusion CC (`CC_Base_L_Upperarm`, `CC_Base_Spine01`, …)
- Omniverse RL rig paths (`L_Upperarm`, `Spine01`, `Waist`, … — short names from USD export)

If animation looks stiff, check the bone map in devtools; add aliases in
`synthetic-pov.html` → `OP_BONES` if your export uses different names.

## Production (Render)

The operator is **disabled** on hosted URLs. Only the local Spark viewer loads GLB
rigs for alignment work.
