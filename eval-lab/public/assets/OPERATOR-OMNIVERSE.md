# Omniverse / Blender operator GLB

The Spark viewer loads a rigged GLB for the factory operator (local dev only).
Default low-poly fallback: `operator-worker.glb` (~5k tris).

## Recommended path: Blender (USD → GLB)

Use this instead of the Python `usd2gltf` script — it preserves skinning,
textures, and materials correctly.

### 1. Import USD

| Setting | Value |
|---------|--------|
| **File** | `Worker/Props/Worker.usd` (or `Worker/Props/Worker.Worker_Idle_Pose.usd`) |
| **Blender** | 3.6+ or 4.x with USD support |

Steps:

1. **File → Import → Universal Scene Description (.usd)**
2. Open `eval-lab/public/assets/Worker/Props/Worker.usd`
3. Do **not** use top-level `Worker/Worker.usd` (references missing Debra lighting).

After import, the character may be **~100× too large** (Omniverse uses cm,
`metersPerUnit = 0.01`).

4. Select **armature + all skinned meshes** (A in outliner with root selected).
5. **Object → Apply → All Transforms** (especially **Scale**).
6. In the sidebar (N panel) → **Item → Dimensions**, confirm height ≈ **1.7–1.8 m**
   on the vertical axis before export. If still ~180, scale root to **0.01** and
   Apply Scale again.

### 2. Orientation (face the station)

The scene is **Y-up**, **meters**. The operator should:

- Stand upright on **+Y** (feet at ground level)
- Face **−Z** (glTF / Three.js forward — same convention as the low-poly worker)

In Blender (Z-up viewport), rotate the character on **Z** until the chest faces
the direction that becomes **−Z** in glTF (use **File → Export → glTF 2.0 →
check “+Y Up”** preview, or trial in the viewer).

Fine-tune facing in the viewer with the HUD **yaw** slider (~**−180°** is the
usual starting point for Station 1).

### 3. Export glTF Binary (.glb)

**File → Export → glTF 2.0 (.glb/.gltf)**

| Section | Setting | Value |
|---------|---------|--------|
| **Format** | | **glTF Binary (.glb)** |
| **Include** | Limit to | **Visible Objects** (or Selected — armature + all meshes) |
| **Transform** | | **+Y Up** (default) |
| **Geometry** | Apply Modifiers | **On** |
| | UVs | **On** |
| | Normals | **On** |
| | Tangents | Off (optional) |
| | Vertex Colors | Off |
| **Materials** | | **Export** (PBR) |
| **Images** | | **Automatic** (embed textures in GLB) |
| **Compression** | Draco | **Off** |
| **Armature** | Use Rest Position | **On** |
| | Export Deformation Bones Only | **On** |
| | Add Leaf Bones | **Off** |
| **Skinning** | Include All Influences | **On** |
| | Bone Influences | **4** (matches Three.js limit) |
| **Animation** | | Optional — include one **Idle** clip if available; not required for placement |

Save as:

```
eval-lab/public/assets/operator-blender.glb
```

If Three.js fails to load your export (`Cannot read properties of undefined (reading 'type')`),
run the bufferView repair (some exporters omit `"buffer": 0`):

```bash
python3 scripts/fix-glb-bufferviews.py eval-lab/public/assets/Worker/Worker.glb
```

Or place a repaired export at `Worker/Worker.glb` — the viewer loads that **first**.

The viewer loads **`operator-blender.glb` first** (no USD axis/unit hacks).
Hard-refresh: `http://localhost:3001/synthetic-pov?zone=1`

Override for testing: `?opGlb=/lab/assets/your-export.glb`

### 4. Verify in the viewer

1. DevTools console: `[splat] operator GLB loaded from .../operator-blender.glb`
2. HUD shows plausible tri count (tens of thousands, not 5.2k).
3. Console: `[splat] operator bone map` — `lArm`, `spine`, `head` should be non-null.
4. Tune **scale**, **op fwd**, **op side**, **yaw** per zone; **Save pose**.

Target operator height in scene: **`targetHeightM: 1.08`** (meters). Export at
real-world scale (~1.7 m) and let the viewer auto-fit, or tune the scale slider.

---

## Load order (local viewer)

1. `?opGlb=...` URL override
2. `Worker/Worker.glb` ← primary test export (run `fix-glb-bufferviews.py` if load fails)
3. `operator-blender.glb`
4. `operator-worker.glb` ← low-poly default
5. `operator-omniverse.glb` ← legacy usd2gltf (axis fixes applied)
6. CDN fallback

---

## Legacy: Python USD → GLB

Only if Blender is unavailable:

```bash
.venv-usd/bin/python scripts/convert-worker-usd-to-glb.py
```

Writes `operator-omniverse.glb` (~72 MB). Skinning is often corrupted; prefer Blender.

---

## Rig / bone names

Pose animation maps these bone groups (aliases in `synthetic-pov.html` → `OP_BONES`):

| Role | Accepts (examples) |
|------|---------------------|
| spine | `Waist`, `CC_Base_Waist`, `Spine01`, `mixamorigSpine` |
| spine1 | `Spine01`, `CC_Base_Spine01` |
| neck | `NeckTwist02`, `CC_Base_Neck` |
| head | `Head`, `CC_Base_Head` |
| lArm / rArm | `L_Upperarm`, `R_Upperarm`, `CC_Base_L_Upperarm`, … |
| lForeArm / rForeArm | `L_Forearm`, `R_Forearm`, … |

Blender often exports short names (`L_Upperarm`) or `mixamorig`-style names —
both work if the bone map in devtools is populated.

---

## Station 1 defaults (`station1-mesh-align.json`)

Use as HUD starting points after export:

| Field | Value |
|-------|--------|
| `targetHeightM` | 1.08 |
| `yaw` | −180° |
| `fwd` | −0.34 m |
| `side` | −0.06 m |
| `scale` | ~0.58 (auto-calculated from height if not set) |

---

## Production (Render)

Operator GLB is **disabled** on hosted URLs. Local Spark viewer only.
