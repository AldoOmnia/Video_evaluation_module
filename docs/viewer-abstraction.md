# Viewer Abstraction — Spark today, Omniverse later

The synthetic POV viewer (`eval-lab/public/synthetic-pov.html`) renders a
3DGS environment with Spark and overlays a rigged operator GLB with Three.js.
The plan is to eventually swap Spark for a physics-enabled viewer built on
NVIDIA Omniverse (NuRec/USD + Isaac Sim physics) fed by real data pipelines.
This document pins down the seam so that swap does not require rewriting the
operator, station, or evaluation logic.

## Architecture today

Two script blocks inside `synthetic-pov.html`:

| Block | Runtime | Owns |
|---|---|---|
| Classic script | Three.js r128 (global) | World-view point cloud, timeline, IMU charts, tour orchestration, splat HUD |
| Module script | Three.js 0.180 + `@sparkjsdev/spark` | Spark splat viewer, operator rig, station mesh BVH, hotspot portals, zone alignment, calibration API |

They communicate only through `window.SplatViewer`, `window.__SPLAT_TOUR`,
and the `splat-load` CustomEvent (which carries `mountGen` for staleness
checks). Keep it that way — this boundary is the swap seam.

## The public contract (`window.SplatViewer`)

Anything outside the module block must go through this API:

- `mount(url, fileType, opts)` — load a zone (opts: `tour`, `zoneIndex`, `flipY`, …)
- `isReady()`, `setCalibrate`, `saveOrigin`, `savePortal`, `saveZoneAlign`, `getZoneAlignDump`
- `groundOperatorToFloor()` — snap operator feet to sampled floor
- **Locomotion foundation** (added in the audit pass):
  - `moveOperatorTo(x, z, { speedMps, targetFeetY, onArrive })` — walk the
    operator to a world XZ target. With `targetFeetY`, feet Y lerps from the
    start height to that value along the path (used for portal-registered
    endpoints); otherwise the floor is re-sampled every 0.35 m
    (station-mesh BVH raycast when loaded, splat footprint sampling otherwise)
  - `stopOperatorWalk()`
  - `isOperatorWalking()`
  - `getOperatorPose()` → `{ x, y, z, yaw, zoneIndex, visible }`
- **Named-station walking** (chat commands):
  - `runOperatorCommand("Move towards the UNICOMM system")` — parses free text
    against each zone's `label`, `desc`, and `aliases` in `SPLAT_TOUR`, then
    walks the operator to that station's portal-registered point in the
    active zone's frame (stops 0.45 m short and faces the station).
    `stop` / `halt` cancels an in-flight walk.
  - `walkOperatorToStation(indexOrName, { speedMps, onArrive })` — same, by
    zone index or name.
  - `resolveStationIndexFromText(text)` → zone index or `null`.
  - The dev-only chat bar at the bottom of the splat quadrant
    (`#splatOpCmd`) feeds `runOperatorCommand` directly.

A future backend must implement the same contract. The locomotion API is
deliberately declarative (target, speed, arrival callback) rather than
imperative per-frame stepping, so a physics engine can own the actual motion.

## Surface adapter — what Omniverse must replace

The operator/anchor math only touches the environment through these
functions. Together they are the implicit `SurfaceAdapter` interface:

| Function | Role | Omniverse equivalent |
|---|---|---|
| `mount()` / `dispose` of `SplatMesh` | load/unload a zone | USD stage load / NuRec layer |
| `findCaptureOrigin(splat, stride, capture)` | derive POV origin from splat density | baked capture origins (already supported via `capture.origin`) |
| `sampleFloorYAt` / `sampleOperatorFootprintFloor` | splat-space floor height | PhysX ground raycast |
| `sampleStationMeshFootprintFloor` (BVH raycast) | mesh floor height | same, native |
| `resolveOperatorFloorY` | per-zone feet Y policy | collapses into a single physics query |
| `splat-load` event with `mountGen` | zone-ready signal | stage-loaded signal |

Everything else — zone alignment config (`SPLAT_TOUR` + `station1-mesh-align.json`),
operator anchor math (`getOperatorAnchorForZone`), pose profiles, bone
mapping, HUD calibration — is viewer-agnostic and carries over unchanged.

## Grounding policy (as of the audit pass)

- **Zone 0 (Station 1, home zone):** calibrated. Saved `feetBaseY` /
  station-mesh BVH floor is authoritative.
- **Other zones:** each `.spz` export has its own floor height, so the zone's
  splat floor is sampled once and cached (`_zoneFloorCache`), falling back to
  `capture.origin[1] − eyeHeight`. The cache entry is invalidated when the
  zone's splat re-mounts.
- The 162 MB station mesh is only aligned for Station 1 — never use it to
  ground other zones.

## Config precedence (Station 1)

`applyTourStationDefaults()` (embedded `SPLAT_TOUR`) → localStorage overrides
→ `station1-mesh-align.json` (fetched once) → URL query overrides
(`meshScale`, `opGlb`, …). The JSON file is the authoritative saved
calibration; the embedded tour block must be kept numerically identical
(`uniformScaleMult: 0.588844`, `targetHeightM: 1.65`, etc.).

Cache busting for the operator GLB is centralized in
`OPERATOR_V5_CACHE_VER` + `withOperatorCacheBust()` — bump the constant when
re-exporting `worker_blender_v5.glb`; config files may keep bare URLs.

## Data-pipeline hooks (future)

When real pipelines land, the natural attach points are:

- `getOperatorPose()` polled or pushed per frame → telemetry out
- `moveOperatorTo()` driven by recorded operator trajectories → replay in
- `splat-load` event detail (`zoneIndex`, `origin`, `numSplats`) → session context
- The classic-script timeline already simulates this flow with synthetic data;
  swap its generator for a WebSocket/SSE feed without touching the module block.
