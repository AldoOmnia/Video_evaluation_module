/**
 * Orchestrator: locked camera pose + anchors + slider values → structure.
 *
 * Runs the three stages in order — lay out the skeleton, size it with the beam
 * model, mesh the blended solid — and returns everything the page and the
 * exporters need. The `solid` it returns is a plain description (cones, plate,
 * pads, holes) in metres; the OBJ is meshed from it in the browser and the STEP
 * is built from the very same description on the server, so both exports are
 * the same part.
 */
import * as V from "./vec.js";
import { buildSkeleton, measureClearance, ringOf } from "./skeleton.js";
import { MATERIALS, sizeFrame } from "./frame.js";
import { meshSolid, meshVolume } from "./surface.js";

/** Mesh cell size per quality level, metres. */
export const QUALITY = { drag: 0.004, settle: 0.002, export: 0.001 };

// Fasteners. Camera screws are M3 per Cognex; feet take M6.
const CAM_HOLE_R = 0.0017; // M3 clearance, 3.4 mm
const CAM_ACCESS_R = 0.0035; // room for the screw head and a hex key
const FOOT_HOLE_R = 0.0033; // M6 clearance, 6.6 mm
const FOOT_ACCESS_R = 0.0065;
const PAD_THICKNESS = 0.008;
const CAM_ACCESS_DEPTH = 0.045; // straight run for a hex key behind each camera screw
const FOOT_ACCESS_DEPTH = 0.03;
export const PLATE_MARGIN = 0.009; // plate edge beyond the hole centres

/** How the support holds the camera — see `holders` in the schema. */
export const HOLDERS = ["plate", "cradle", "sleeve"];
const HOLDER_FIT = 0.0003; // air between a cradle or sleeve and the camera's sides and top
const CABLE_MARGIN = 0.004; // the cable corridor is this much wider than the body all round

/**
 * A camera entry from the schema (mm, g) as the generator wants it (m, kg).
 *
 * `body` and `mount` are in the camera's own frame — x along the view, y
 * across, z up, origin on the optical axis at mid length — and are null for a
 * camera described only by its envelope.
 */
export function cameraSpecSI(c) {
  const mm = (v) => v / 1000;
  const body = c.body_mm
    ? c.body_mm.map((b) => ({
        name: b.name,
        c: [mm(b.x[0] + b.x[1]) / 2, mm(b.y[0] + b.y[1]) / 2, mm(b.z[0] + b.z[1]) / 2],
        half: [mm(b.x[1] - b.x[0]) / 2, mm(b.y[1] - b.y[0]) / 2, mm(b.z[1] - b.z[0]) / 2],
        relief: mm(b.relief_mm ?? 0),
      }))
    : null;
  return {
    size: c.size_mm.map(mm),
    holes: c.holes_mm.map(mm),
    mass: c.mass_g / 1000,
    mountFace: c.mountFace,
    body,
    mount: c.mount_mm ? { at: c.mount_mm.map(mm), face: c.mountFace } : null,
    grip: c.grip_mm ? c.grip_mm.map(mm) : null,
  };
}

/** A point given in the camera's frame, in the scan's. */
const fromCamera = (cam, q) => V.add(cam.center, V.add(V.scale(cam.view, q[0]), V.add(V.scale(cam.right, q[1]), V.scale(cam.up, q[2]))));

/** Convert slider values as shown in the UI (mm, %) to SI using the schema. */
export function toSI(values, schema) {
  const P = {};
  for (const s of schema.sliders) {
    const v = values[s.id] ?? s.default;
    P[s.id] = V.clamp(Number(v), s.min, s.max) * s.scale;
  }
  P.material = MATERIALS[values.material] ? values.material : schema.defaultMaterial;
  P.holder = HOLDERS.includes(values.holder) ? values.holder : (schema.defaultHolder ?? "plate");
  return P;
}

/** Complete the camera's frame from its view direction and an up hint. */
export function cameraFrame(center, view, upHint = [0, 0, 1]) {
  const f = V.norm(view, [1, 0, 0]);
  let up = V.reject(upHint, f);
  up = V.len(up) > 1e-4 ? V.norm(up) : V.basis(f)[0];
  return { center: center.slice(), view: f, up, right: V.cross(f, up) };
}

/**
 * Where the plate sits on the camera body. `size` is [along view, across, up].
 * The face is fixed by the locked pose — nothing downstream moves it.
 */
export function deriveMount(camera, face, holes, P) {
  const [L, W, H] = camera.size;
  const faces = {
    bottom: { n: V.scale(camera.up, -1), off: H / 2, u: camera.view, v: camera.right },
    top: { n: camera.up, off: H / 2, u: camera.view, v: camera.right },
    back: { n: V.scale(camera.view, -1), off: L / 2, u: camera.right, v: camera.up },
    left: { n: V.scale(camera.right, -1), off: W / 2, u: camera.view, v: camera.up },
    right: { n: camera.right, off: W / 2, u: camera.view, v: camera.up },
  };
  // A camera with a drawn bolt pattern says where its plate goes; a plain
  // envelope gets it in the middle of the chosen face.
  const f = faces[camera.mount?.face ?? face] ?? faces.bottom;
  const w = holes[0] + 2 * PLATE_MARGIN;
  const h = holes[1] + 2 * PLATE_MARGIN;
  return {
    p: camera.mount ? fromCamera(camera, camera.mount.at) : V.addScaled(camera.center, f.n, f.off),
    n: f.n, u: f.u, v: f.v, w, h,
    holes: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [(a * holes[0]) / 2, (b * holes[1]) / 2]),
    thickness: P.plateThickness,
  };
}

/** A box given by its extent along the camera's own axes, in the scan's frame. */
const cameraBox = (cam, x, y, z) => ({
  c: fromCamera(cam, [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2]),
  u: cam.view, v: cam.right, n: cam.up,
  half: [(x[1] - x[0]) / 2, (y[1] - y[0]) / 2, (z[1] - z[0]) / 2],
});

/**
 * What holds the camera besides its screws, and the space behind it kept for
 * the cables. Everything is in the camera's frame (x along the view, y across,
 * z up), so it follows the locked pose and nothing else.
 *
 * A cradle or sleeve is the mounting plate grown round the body: the floor is
 * the plate, on the same face with the same four screws, so the camera sits
 * exactly where the plate alone would hold it. The sides and top stand
 * `HOLDER_FIT` off the body; the floor does not.
 *
 * @returns {{style, outer, cavity, grip, rearFree, wall, volume, cable}}
 *          `outer`, `cavity`, `cable` are {x, y, z} extents or null; `style`
 *          is what was actually built — "plate" when the camera has no drawn
 *          body to wrap.
 */
export function deriveHolder(camera, mount, P) {
  const at = camera.mount?.at;
  const solids = camera.body ?? [];
  // The solid the plate bolts to.
  const b = at && camera.mount.face === "bottom"
    ? solids.find((q) => Math.abs(at[0] - q.c[0]) <= q.half[0] + 1e-9 && Math.abs(at[1] - q.c[1]) <= q.half[1] + 1e-9 && Math.abs(q.c[2] - q.half[2] - at[2]) < 1e-6)
    : null;
  const out = { style: "plate", outer: null, cavity: null, grip: 0, rearFree: 0, wall: 0, volume: mount.w * mount.h * mount.thickness, cable: null };

  if (b && P.holder !== "plate") {
    const T = mount.thickness;
    const wall = V.clamp(T * 0.6, 0.003, 0.008);
    const body = { x: [b.c[0] - b.half[0], b.c[0] + b.half[0]], y: b.half[1], top: b.c[2] + b.half[2] };
    const limit = camera.grip ?? body.x;
    // Wrapped stretch: centred on the bolt pattern, never shorter than the
    // plate it replaces, never past the housing.
    const x = [
      Math.max(Math.min(at[0] - P.gripLength / 2, at[0] - mount.w / 2), limit[0]),
      Math.min(Math.max(at[0] + P.gripLength / 2, at[0] + mount.w / 2), limit[1]),
    ];
    const Y = Math.max(mount.h / 2, body.y + HOLDER_FIT + wall);
    const sleeve = P.holder === "sleeve";
    const top = sleeve ? body.top + HOLDER_FIT + wall : body.top;
    const inner = { y: body.y + HOLDER_FIT, top: body.top + HOLDER_FIT };
    out.style = P.holder;
    out.outer = { x, y: [-Y, Y], z: [at[2] - T, top] };
    // The pocket runs out of both ends, and out of the top of a cradle.
    out.cavity = { x: [x[0] - 0.01, x[1] + 0.01], y: [-inner.y, inner.y], z: [at[2], sleeve ? inner.top : top + 0.02] };
    out.grip = x[1] - x[0];
    out.rearFree = x[0] - body.x[0];
    out.wall = wall;
    out.volume = (x[1] - x[0]) * (2 * Y * (top - at[2] + T) - 2 * inner.y * (Math.min(top, inner.top) - at[2]));
  }

  // Cables leave straight out of the back of the rearmost solid. From the
  // back of whatever holds the camera to `cableClearance` behind the
  // connectors, nothing is routed and nothing is left standing.
  const rear = solids.reduce((m, q) => (!m || q.c[0] - q.half[0] < m.c[0] - m.half[0] ? q : m), null);
  if (rear && P.cableClearance > 0 && (camera.mount?.face ?? "bottom") !== "back") {
    const back = rear.c[0] - rear.half[0];
    const from = out.outer && rear === b ? out.outer.x[0] : back;
    out.cable = {
      x: [back - P.cableClearance, from - 0.0005],
      y: [rear.c[1] - rear.half[1] - CABLE_MARGIN, rear.c[1] + rear.half[1] + CABLE_MARGIN],
      z: [rear.c[2] - rear.half[2] - CABLE_MARGIN, rear.c[2] + rear.half[2] + CABLE_MARGIN],
    };
  }
  return out;
}

/** The solid as primitives: what gets meshed, and what the STEP is built from. */
export function describeSolid(sk, scene, mount, P, holder = deriveHolder(scene.camera, mount, P)) {
  const cones = [];
  for (const [ci, c] of sk.chains.entries()) {
    for (let k = 0; k < c.nodes.length - 1; k++) {
      const a = sk.nodes[c.nodes[k]], b = sk.nodes[c.nodes[k + 1]];
      cones.push({ a: a.p, b: b.p, ra: a.r, rb: b.r, id: ci });
    }
  }
  let id = sk.chains.length;

  const t = mount.thickness;
  // The plate — or, for a cradle or sleeve, the block the camera's pocket is
  // cut from, whose floor is the plate.
  const boxes = [holder.outer
    ? { ...cameraBox(scene.camera, holder.outer.x, holder.outer.y, holder.outer.z), round: Math.min(0.002, holder.wall / 3), id: id++, role: holder.style }
    : {
        c: V.addScaled(mount.p, mount.n, t / 2),
        u: mount.u, v: mount.v, n: mount.n,
        half: [mount.w / 2, mount.h / 2, t / 2],
        round: Math.min(0.002, t / 4),
        id: id++, role: "plate",
      }];

  const cutCyls = [];
  for (const [du, dv] of mount.holes) {
    const at = V.addScaled(V.addScaled(mount.p, mount.u, du), mount.v, dv);
    cutCyls.push({ c: V.addScaled(at, mount.n, -0.001), n: mount.n, r: CAM_HOLE_R, h: t + 0.002, role: "camera-screw" });
    // The neck grows out of the back of the plate, over the screws. Keep a
    // straight channel open behind each one so they can be driven.
    cutCyls.push({ c: V.addScaled(at, mount.n, t), n: mount.n, r: CAM_ACCESS_R, h: CAM_ACCESS_DEPTH, role: "camera-screw-access" });
  }

  const discs = [];
  const cutPlanes = [];
  // A ring anchor's base is the ring itself: one flat annulus on the face,
  // which the legs run into. Its fixing holes belong to the part it sits on
  // and are not guessed at here.
  const rings = [];
  for (const a of scene.anchors) {
    if (a.kind !== "ring") continue;
    const g = ringOf(a, P);
    rings.push({ ...g, round: Math.min(0.002, g.h / 4), id: id++ });
    cutPlanes.push({ p: g.c, n: g.n, r: g.R + g.half + P.blend + 0.01 });
  }
  for (const f of sk.feet) {
    if (f.ring) continue;
    const nd = sk.nodes[f.node];
    const padR = nd.r + 2 * FOOT_ACCESS_R + 0.006;
    discs.push({ c: f.p, n: f.n, r: padR, h: PAD_THICKNESS, id: id++ });
    cutPlanes.push({ p: f.p, n: f.n, r: padR + P.blend + 0.01 });
    // The leg arrives leaning one way. Put one bolt directly opposite the
    // lean and the other two as far round as three-fold spacing allows, so
    // the access channels scallop the leg at most and never cut through it.
    const [u, v] = V.basis(f.n);
    const lean = V.reject(V.sub(sk.nodes[f.prev].p, f.p), f.n);
    const phase = V.len(lean) > 1e-6 ? Math.atan2(V.dot(lean, v), V.dot(lean, u)) + Math.PI : 0;
    const ringR = padR - FOOT_ACCESS_R - 0.002;
    for (let k = 0; k < 3; k++) {
      const th = phase + (2 * Math.PI * k) / 3;
      const at = V.add(f.p, V.add(V.scale(u, ringR * Math.cos(th)), V.scale(v, ringR * Math.sin(th))));
      cutCyls.push({ c: V.addScaled(at, f.n, -0.001), n: f.n, r: FOOT_HOLE_R, h: PAD_THICKNESS + 0.002, role: "foot-bolt" });
      cutCyls.push({ c: V.addScaled(at, f.n, PAD_THICKNESS), n: f.n, r: FOOT_ACCESS_R, h: FOOT_ACCESS_DEPTH, role: "foot-bolt-access" });
    }
  }

  // Nothing may grow into the space the camera body occupies. A box with
  // `relief` is cut that much oversize: a face the support only passes, and
  // does not bolt to, should not end up in contact with it.
  const cam = scene.camera;
  const bodies = cam.body?.length ? cam.body : [{ c: [0, 0, 0], half: cam.size.map((v) => v / 2), relief: 0 }];
  const cutBoxes = bodies.map((b) => ({
    c: fromCamera(cam, b.c), u: cam.view, v: cam.right, n: cam.up,
    half: b.half.map((h) => h + (b.relief ?? 0)), round: 0, role: "camera-body",
  }));
  if (holder.cavity) cutBoxes.push({ ...cameraBox(cam, holder.cavity.x, holder.cavity.y, holder.cavity.z), round: 0, role: "holder-pocket" });
  if (holder.cable) cutBoxes.push({ ...cameraBox(cam, holder.cable.x, holder.cable.y, holder.cable.z), round: 0, role: "cable-room" });

  return { units: "m", cones, boxes, discs, rings, cutCyls, cutBoxes, cutPlanes, blend: P.blend };
}

/**
 * @param {object} scene
 * @param {object} scene.camera    { center, view, up, right, size:[L,W,H], fovDeg, range, mass, body?, mount? }
 *                                 — body and mount as returned by cameraSpecSI()
 * @param {string} scene.mountFace bottom | back | top | left | right
 * @param {number[]} scene.holes   [along, across] hole spacing, metres
 * @param {Array}  scene.anchors   [{ p, n }], or { kind: "ring", p, n, rIn, rOut } for a flat round face
 * @param {object} [scene.field]   obstacle distance field (scan with the old arm removed)
 * @param {object} P               slider values in SI — see toSI()
 * @param {object} [opts]          { quality: 'drag'|'settle'|'export', cell, mesh: boolean }
 */
export function generate(scene, P, opts = {}) {
  const quality = opts.quality ?? "settle";
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();

  const mat = MATERIALS[P.material] ?? MATERIALS.al6061;
  const mount = deriveMount(scene.camera, scene.mountFace, scene.holes, P);
  const holder = deriveHolder(scene.camera, mount, P);
  // The router treats the cable room as part of the camera: struts keep off it.
  const routed = holder.cable
    ? {
        ...scene.camera,
        body: [
          ...(scene.camera.body?.length ? scene.camera.body : [{ c: [0, 0, 0], half: scene.camera.size.map((v) => v / 2), relief: 0 }]),
          { name: "cable room", c: ["x", "y", "z"].map((k) => (holder.cable[k][0] + holder.cable[k][1]) / 2), half: ["x", "y", "z"].map((k) => (holder.cable[k][1] - holder.cable[k][0]) / 2), relief: 0 },
        ],
      }
    : scene.camera;
  const sk = buildSkeleton({ camera: routed, mount, anchors: scene.anchors }, P, scene.field);
  // Tag each foot with its node so pads can follow the sized strut.
  const legs = sk.chains.filter((c) => c.kind === "branch");
  sk.feet.forEach((f, i) => {
    f.node = legs[i].nodes[legs[i].nodes.length - 1];
    f.prev = legs[i].nodes[legs[i].nodes.length - 2];
  });
  const t1 = now();

  const plateMass = mat.rho * holder.volume;
  const frame = sizeFrame(sk, P, mat, scene.camera.mass, quality === "drag" ? 4 : 7, { [sk.iPlate]: plateMass });
  if (!frame) throw new Error("the structure is not restrained — check the anchor points");
  const t2 = now();

  const solid = describeSolid(sk, scene, mount, P, holder);
  let mesh = null;
  let volume = null;
  if (opts.mesh !== false) {
    mesh = meshSolid(solid, opts.cell ?? QUALITY[quality] ?? QUALITY.settle);
    volume = meshVolume(mesh.positions, mesh.indices);
  }
  const t3 = now();

  const clear = measureClearance(sk, scene.field);
  const ringMass = solid.rings.reduce((m, g) => m + mat.rho * 2 * Math.PI * g.R * 2 * g.half * g.h, 0);
  let height = 0;
  for (const f of sk.feet) height = Math.max(height, V.dist(f.p, scene.camera.center));
  const metrics = {
    deflection: frame.worstDisp,
    sag: frame.sag,
    tilt: frame.tilt,
    frequency: frame.f1,
    target: frame.target,
    met: frame.met,
    mass: volume != null ? volume * mat.rho : frame.structuralMass + plateMass + ringMass,
    volume,
    material: P.material,
    clearanceScan: clear.scan,
    clearanceView: clear.view,
    reach: height,
    feet: sk.feet.length,
    rings: solid.rings.length,
    holder: { style: holder.style, asked: P.holder, grip: holder.grip, rearFree: holder.rearFree, wall: holder.wall, cable: holder.cable ? P.cableClearance : 0 },
    struts: sk.elements.length - 1,
    triangles: mesh ? mesh.indices.length / 3 : 0,
    pieces: mesh ? mesh.pieces : 1,
    holesShown: mesh ? mesh.skippedHoles === 0 : false,
    ms: { layout: t1 - t0, sizing: t2 - t1, mesh: t3 - t2 },
  };

  return { skeleton: sk, mount, holder, solid, mesh, metrics };
}
