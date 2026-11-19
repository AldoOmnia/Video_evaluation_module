/**
 * Camera-support generator — worker.
 *
 * Everything heavy runs here so the viewer never stalls while a slider is
 * moving: reading the scan, finding the arm, building the obstacle field, and
 * regenerating the structure. The page keeps its own copy of the points for
 * drawing; this side keeps one for geometry.
 *
 * Messages in → out (each reply echoes the request's `id`):
 *   load     { buffer }                      → loaded  { positions, colors, count, upAxis, floor, comments }
 *   sample   {}                              → loaded  { …, sample: true, truth }
 *   arm      { seed, reach }                 → arm     { mask, count }
 *   brush    { center, radius, value }       → arm     { mask, count }
 *   clearArm {}                              → arm     { mask, count: 0 }
 *   flip     {}                              → flipped { positions, floor, bounds, orient }
 *   plane    { center, radius, toward }      → plane   { p, n, rms, count, flat }
 *   ring     { center, toward }              → ring    { ok, reason?, c, n, rIn, rOut, rms, coverage, count }
 *   blob     { center, radius }              → blob    { p }
 *   scene    { camera, mountFace, holes, anchors } → scene { field }
 *   generate { values, quality }             → result  { mesh arrays, metrics, solid, lines }
 *   obj      { values, name, lines }         → obj     { blob, metrics, solid }
 *   probe    { candidates: [values] }        → probe   { results: [metrics | { error }] }
 */
import { parsePLY } from "./core/ply.js";
import * as scan from "./core/scan.js";
import { makeSampleScan, SAMPLE_TRUTH } from "./core/sample.js";
import { buildDistanceField } from "./core/field.js";
import { generate, toSI } from "./core/generate.js";
import { writeOBJ } from "./core/obj.js";

let schema = null;
let positions = null; // Float32Array, metres, Z up
let mask = null; // Uint8Array, 1 = belongs to the temporary arm
let scene = null; // { camera, mountFace, holes, anchors, field }
let orient = "z+"; // which of the file's axes is up here, and whether it was turned over

const reply = (id, type, data = {}, transfer = []) => self.postMessage({ id, type, ...data }, transfer);

function adopt(cloud, extra = {}) {
  positions = cloud.positions;
  mask = new Uint8Array(cloud.count);
  scene = null;
  const up = scan.detectUpAxis(positions);
  if (up.axis === "y") scan.yUpToZUp(positions);
  // A Gaussian splat keeps the axes of the cameras it was trained from, where
  // +Y points down: such a file is upside down after the turn above. This is a
  // convention, not a measurement, which is why the page offers Flip.
  const down = Boolean(cloud.splat) && up.axis === "y";
  if (down) scan.flipUp(positions);
  orient = `${up.axis}${down ? "-" : "+"}`;
  const out = positions.slice();
  const colors = cloud.colors;
  return [
    {
      positions: out, colors, count: cloud.count, upAxis: up.axis, orient, splat: Boolean(cloud.splat),
      floor: scan.floorHeight(positions), bounds: scan.boundsOf(positions),
      comments: cloud.comments ?? [], ...extra,
    },
    colors ? [out.buffer, colors.buffer] : [out.buffer],
  ];
}

const armReply = (id) => {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  const copy = mask.slice();
  reply(id, "arm", { mask: copy, count }, [copy.buffer]);
};

const handlers = {
  init({ id, schema: s }) {
    schema = s;
    reply(id, "ready");
  },

  load({ id, buffer }) {
    const [data, transfer] = adopt(parsePLY(buffer));
    reply(id, "loaded", data, transfer);
  },

  sample({ id }) {
    const [data, transfer] = adopt(makeSampleScan(), { sample: true, truth: SAMPLE_TRUTH });
    reply(id, "loaded", data, transfer);
  },

  arm({ id, seed, reach }) {
    mask = scan.findArm(positions, { seed, reach }).mask;
    armReply(id);
  },

  brush({ id, center, radius, value }) {
    scan.brush(positions, mask, center, radius, value);
    armReply(id);
  },

  clearArm({ id }) {
    mask.fill(0);
    armReply(id);
  },

  /** Turn the scan over. Point order is unchanged, so the arm mask still applies. */
  flip({ id }) {
    scan.flipUp(positions);
    orient = `${orient[0]}${orient[1] === "+" ? "-" : "+"}`;
    scene = null;
    const out = positions.slice();
    reply(id, "flipped", { positions: out, floor: scan.floorHeight(positions), bounds: scan.boundsOf(positions), orient }, [out.buffer]);
  },

  ring({ id, center, toward }) {
    reply(id, "ring", scan.fitRing(positions, center, mask, toward));
  },

  plane({ id, center, radius, toward }) {
    reply(id, "plane", scan.fitPlane(positions, center, radius, mask, toward));
  },

  blob({ id, center, radius }) {
    reply(id, "blob", { p: scan.blobCentre(positions, center, radius) });
  },

  scene({ id, camera, mountFace, holes, anchors }) {
    // The field covers the camera, the anchors and a margin: everything the
    // structure could plausibly pass. The arm is left out — it is going away.
    // A ring anchor is given by its centre; the face it sits on is out at its rim.
    const reach = anchors.reduce((m, a) => Math.max(m, a.rOut ?? 0), 0);
    const bounds = scan.workBounds(camera.center, anchors, 0.5 + reach);
    const t0 = performance.now();
    const field = buildDistanceField(scan.obstaclePoints(positions, mask, bounds), bounds, { cell: 0.02 });
    scene = { camera, mountFace, holes, anchors, field };
    reply(id, "scene", { field: { dims: field.dims, cell: field.cell, solid: field.solid, ms: performance.now() - t0 } });
  },

  generate({ id, values, quality }) {
    if (!scene) throw new Error("lock the camera pose and pick an anchor first");
    const r = generate(scene, toSI(values, schema), { quality });
    const { positions: P, normals: N, indices: I } = r.mesh;
    // Centre-lines, for the skeleton overlay.
    const lines = [];
    for (const c of r.skeleton.chains) {
      for (let k = 0; k < c.nodes.length - 1; k++) lines.push(...r.skeleton.nodes[c.nodes[k]].p, ...r.skeleton.nodes[c.nodes[k + 1]].p);
    }
    reply(id, "result", {
      quality, positions: P, normals: N, indices: I, metrics: r.metrics, solid: r.solid,
      lines: Float32Array.from(lines), mount: r.mount, holder: r.holder,
      feet: r.skeleton.feet.map((f) => ({ p: f.p, n: f.n })),
    }, [P.buffer, N.buffer, I.buffer]);
  },

  /**
   * Measure settings without drawing them, at the quality the viewer settles
   * to, so the numbers match what the KPI cards will show. This is what lets
   * the assistant's proposals be checked against the solver before anything
   * on screen changes.
   */
  probe({ id, candidates }) {
    if (!scene) throw new Error("lock the camera pose and pick an anchor first");
    const results = candidates.map((values) => {
      try {
        return generate(scene, toSI(values, schema), { quality: "settle" }).metrics;
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    });
    reply(id, "probe", { results });
  },

  obj({ id, values, name, lines }) {
    if (!scene) throw new Error("nothing to export yet");
    const r = generate(scene, toSI(values, schema), { quality: "export" });
    const blob = writeOBJ(r.mesh.positions, r.mesh.indices, { name, lines });
    reply(id, "obj", { blob, metrics: r.metrics, solid: r.solid });
  },
};

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    const h = handlers[msg.type];
    if (!h) throw new Error(`unknown message ${msg.type}`);
    h(msg);
  } catch (err) {
    reply(msg.id, "error", { message: err?.message ?? String(err) });
  }
};
