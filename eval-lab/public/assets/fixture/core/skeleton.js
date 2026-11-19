/**
 * Skeleton generator — the layout of the support before it has any thickness.
 *
 * Produces a graph: a trunk leaving the camera's mounting face, splitting into
 * branches that land on the anchors the user picked, with optional ties
 * between branches. Everything downstream (beam sizing, the blended surface,
 * the STEP solid) is derived from this graph, which is why the OBJ and STEP
 * exports describe the same structure.
 *
 * The one hard rule: the mount plate is placed from the locked camera pose and
 * nothing here may move it. Sliders reshape everything between the plate and
 * the anchors.
 *
 * All lengths are metres. The frame is Z-up.
 */
import * as V from "./vec.js";

/** Budget for the dense beam solve in frame.js — see MAX_BRANCHES below. */
const SEGMENT_LENGTH = 0.06;
export const MAX_BRANCHES = 8;

function sampleCurve(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(V.bezier(p0, p1, p2, p3, i / n));
  return out;
}

/** Signed clearance of `p` from the camera's viewing cone; negative is inside. */
function coneClearance(p, cone) {
  const rel = V.sub(p, cone.apex);
  const t = V.dot(rel, cone.axis);
  if (t < -0.02 || t > cone.range) return { d: Infinity, dir: null };
  const radial = V.addScaled(rel, cone.axis, -t);
  const r = V.len(radial);
  const coneR = cone.r0 + Math.max(t, 0) * cone.tan;
  return { d: r - coneR, dir: r > 1e-6 ? V.scale(radial, 1 / r) : null };
}

/**
 * @param {object} scene
 * @param {object} scene.camera  { center, view, up, right, size:[L,W,H], fovDeg, range, body? }
 * @param {object} scene.mount   { p, n, u, v, w, h, holes:[[du,dv]...] } plate on the camera's mounting face
 * @param {Array}  scene.anchors [{ p, n }] attachment points picked on the scan; a ring anchor is
 *                               { kind: "ring", p: centre, n, rIn, rOut } — a flat round face
 * @param {object} P             slider values, see shared/data/fixture-params.json
 * @param {object} [field]       obstacle distance field from field.js
 */
export function buildSkeleton(scene, P, field) {
  const { camera, mount, anchors } = scene;
  if (!anchors || anchors.length === 0) throw new Error("at least one anchor is required");

  const nodes = [];
  const chains = [];
  const addNode = (p, kind) => {
    nodes.push({ p: p.slice(), kind, fixed: false, r: P.minDiameter / 2 });
    return nodes.length - 1;
  };

  const plateT = P.plateThickness;
  const iCam = addNode(camera.center, "camera");
  const iPlate = addNode(V.addScaled(mount.p, mount.n, plateT / 2), "plate");
  const hub = V.addScaled(mount.p, mount.n, plateT + P.standoff);
  const iHub = addNode(hub, "hub");

  // ── Feet ───────────────────────────────────────────────────────────────
  const feetPerAnchor = Math.max(1, Math.min(P.feet, Math.floor(MAX_BRANCHES / anchors.length)));
  const feet = [];
  for (const [ai, a] of anchors.entries()) {
    const n = V.norm(a.n);
    if (a.kind === "ring") {
      // Legs land on the ring, side by side under the camera: spaced by the
      // base spread along the ring, and never more than evenly all the way
      // round. The ring itself is the base; no pads.
      const ring = ringOf(a, P);
      const [u, v] = V.basis(n);
      const toward = V.reject(V.sub(hub, a.p), n);
      const phase = V.len(toward) > 1e-6 ? Math.atan2(V.dot(toward, v), V.dot(toward, u)) : 0;
      const step = Math.min(P.footprint / ring.R, (2 * Math.PI) / feetPerAnchor);
      for (let k = 0; k < feetPerAnchor; k++) {
        const th = phase + (k - (feetPerAnchor - 1) / 2) * step;
        const p = V.add(a.p, V.add(V.scale(u, ring.R * Math.cos(th)), V.scale(v, ring.R * Math.sin(th))));
        feet.push({ p, n, anchor: ai, ring: true });
      }
      continue;
    }
    if (feetPerAnchor === 1) {
      feet.push({ p: a.p.slice(), n, anchor: ai });
      continue;
    }
    const [u, v] = V.basis(n);
    // Point the first foot back under the load so one leg takes it directly.
    const toward = V.reject(V.sub(hub, a.p), n);
    const phase = Math.atan2(V.dot(toward, v), V.dot(toward, u));
    for (let k = 0; k < feetPerAnchor; k++) {
      const th = phase + (2 * Math.PI * k) / feetPerAnchor;
      const dir = V.add(V.scale(u, Math.cos(th)), V.scale(v, Math.sin(th)));
      let radius = P.footprint;
      let p = V.addScaled(a.p, dir, radius);
      // The local plane fit says nothing about where the surface ends. If a
      // foot would land off the edge of the table, pull it in until it sits on
      // scanned material rather than leaving it hanging in the air.
      if (field) {
        const onSurface = (q) => field.sample(q) <= field.cell * 1.5;
        for (let it = 0; it < 6 && !onSurface(p); it++) {
          radius *= 0.7;
          p = V.addScaled(a.p, dir, radius);
        }
      }
      feet.push({ p, n, anchor: ai });
    }
  }

  // ── Trunk ──────────────────────────────────────────────────────────────
  const footCentroid = feet.reduce((s, f) => V.add(s, f.p), [0, 0, 0]).map((x) => x / feet.length);
  const span = V.dist(hub, footCentroid);
  const dir = V.norm(V.sub(footCentroid, hub), [0, 0, -1]);
  // Bow the trunk in the direction it already leaves the camera, so it reads
  // as a gooseneck arcing away from the lens rather than a straight strut
  // cutting across the view.
  let bow = V.reject(mount.n, dir);
  bow = V.len(bow) > 1e-3 ? V.norm(bow) : V.basis(dir)[0];
  const t = V.clamp(P.split, 0.1, 0.9);
  const splitP = V.addScaled(V.lerp(hub, footCentroid, t), bow, P.sweep * span * 2 * t * (1 - t));
  const trunkLen = V.dist(hub, splitP);
  const arrive = V.norm(V.lerp(V.norm(V.sub(splitP, hub)), V.norm(V.sub(footCentroid, splitP), dir), 0.6), dir);

  const nBranches = feet.length;
  const maxSeg = nBranches > 4 ? 6 : 9;
  const nTrunk = V.clamp(Math.round(trunkLen / SEGMENT_LENGTH), 3, maxSeg);
  const trunkPts = sampleCurve(
    hub,
    V.addScaled(hub, mount.n, trunkLen * 0.4),
    V.addScaled(splitP, arrive, -trunkLen * 0.35),
    splitP,
    nTrunk,
  );
  const trunk = [iPlate, iHub];
  for (let i = 1; i <= nTrunk; i++) trunk.push(addNode(trunkPts[i], i === nTrunk ? "split" : "trunk"));
  const iSplit = trunk[trunk.length - 1];
  chains.push({ kind: "trunk", nodes: trunk });

  // ── Branches ───────────────────────────────────────────────────────────
  const ties = nBranches >= 2 ? Math.round(P.ties) : 0;
  const branchNodes = [];
  for (const f of feet) {
    const L = V.dist(splitP, f.p);
    let n = V.clamp(Math.round(L / SEGMENT_LENGTH), 3, maxSeg);
    // Tie rings must land on nodes shared by every branch.
    if (ties > 0) n = (ties + 1) * Math.max(1, Math.round(n / (ties + 1)));
    const pts = sampleCurve(
      splitP,
      V.addScaled(splitP, arrive, L * 0.35),
      V.addScaled(f.p, f.n, Math.min(L * 0.35, 0.18)),
      f.p,
      n,
    );
    const ids = [iSplit];
    for (let i = 1; i <= n; i++) ids.push(addNode(pts[i], i === n ? "foot" : "branch"));
    nodes[ids[ids.length - 1]].fixed = true;
    nodes[ids[ids.length - 1]].n = f.n;
    branchNodes.push(ids);
    chains.push({ kind: "branch", nodes: ids });
  }

  // ── Ties ───────────────────────────────────────────────────────────────
  if (ties > 0) {
    // Order branches around the trunk axis so each tie joins neighbours.
    const [bu, bv] = V.basis(dir);
    const order = feet
      .map((f, i) => {
        const r = V.sub(f.p, footCentroid);
        return { i, ang: Math.atan2(V.dot(r, bv), V.dot(r, bu)) };
      })
      .sort((a, b) => a.ang - b.ang)
      .map((o) => o.i);
    const pairs = nBranches === 2 ? 1 : nBranches;
    for (let level = 1; level <= ties; level++) {
      for (let k = 0; k < pairs; k++) {
        const a = branchNodes[order[k]];
        const b = branchNodes[order[(k + 1) % nBranches]];
        const ia = a[Math.round(((a.length - 1) * level) / (ties + 1))];
        const ib = b[Math.round(((b.length - 1) * level) / (ties + 1))];
        if (V.dist(nodes[ia].p, nodes[ib].p) > 0.012) chains.push({ kind: "tie", nodes: [ia, ib] });
      }
    }
  }

  // ── Keep clear of the scan, the camera body and the camera's view ──────
  const cone = {
    apex: V.addScaled(camera.center, camera.view, camera.size[0] / 2),
    axis: camera.view,
    range: camera.range,
    tan: Math.tan(((camera.fovDeg / 2 + 3) * Math.PI) / 180),
    r0: 0.03,
  };
  // Struts are sized after they are routed, so near the camera they are kept
  // clear by the thickest they are allowed to become: whatever the sizing
  // decides, none of them ends up cut by the camera body.
  // The neck starts on the plate, against the body, so the gap can only open
  // as fast as a strut travels away from the hub.
  const bodyFull = P.maxDiameter / 2 + BODY_GAP;
  const hubGap = Math.max(bodyDistance(camera, hub).d, 0);
  const bodyNeedAt = (p) => Math.min(bodyFull, hubGap + V.dist(p, hub));
  const movable = new Set();
  for (const c of chains) {
    if (c.kind === "tie") continue;
    for (const [k, id] of c.nodes.entries()) {
      if (nodes[id].fixed || id === iPlate || id === iHub) continue;
      if (c.kind === "branch" && k === 0) continue; // the split node belongs to the trunk
      movable.add(id);
    }
  }
  const nearestAnchor = (p) => feet.reduce((m, f) => Math.min(m, V.dist(p, f.p)), Infinity);
  const clearanceAt = (p, r) => {
    // Feet have to touch the surface they bolt to, so the requirement fades
    // out on approach instead of pushing the last nodes off their anchor.
    const fade = V.clamp((nearestAnchor(p) - 0.04) / 0.12, 0, 1);
    return (P.clearance + r) * fade;
  };

  for (let it = 0; it < 14; it++) {
    for (const id of movable) {
      const nd = nodes[id];
      let p = nd.p;
      if (field) {
        const need = clearanceAt(p, nd.r);
        const d = field.sample(p);
        if (d < need) p = V.addScaled(p, field.gradient(p), (need - d) * 0.6);
      }
      const c = coneClearance(p, cone);
      const coneNeed = nd.r + P.clearance;
      if (c.d < coneNeed) p = V.addScaled(p, c.dir ?? bow, (coneNeed - c.d) * 0.7);
      const b = bodyDistance(camera, p);
      const bodyNeed = bodyNeedAt(p);
      if (b.d < bodyNeed) p = V.addScaled(p, b.dir, bodyNeed - b.d);
      nd.p = p;
    }
    // Two nodes either side of a corner of the camera can both be clear while
    // the strut between them is not.
    for (const c of chains) {
      if (c.kind === "tie") continue;
      for (let k = 0; k < c.nodes.length - 1; k++) {
        const ia = c.nodes[k], ib = c.nodes[k + 1];
        for (const t of [0.25, 0.5, 0.75]) {
          const m = V.lerp(nodes[ia].p, nodes[ib].p, t);
          const b = bodyDistance(camera, m);
          const bodyNeed = bodyNeedAt(m);
          if (b.d >= bodyNeed) continue;
          // Move whichever ends can move; an end that cannot leaves the whole
          // correction to the other.
          const free = [movable.has(ia), movable.has(ib)];
          const wa = free[0] ? (free[1] ? 1 - t : 1) : 0, wb = free[1] ? (free[0] ? t : 1) : 0;
          const push = (bodyNeed - b.d) / Math.max(wa * (1 - t) + wb * t, 0.25);
          if (wa) nodes[ia].p = V.addScaled(nodes[ia].p, b.dir, push * wa);
          if (wb) nodes[ib].p = V.addScaled(nodes[ib].p, b.dir, push * wb);
        }
      }
    }
    // Smooth each chain so a node pushed off an obstacle does not leave a kink.
    for (const c of chains) {
      if (c.kind === "tie") continue;
      for (let k = 1; k < c.nodes.length - 1; k++) {
        const id = c.nodes[k];
        if (!movable.has(id)) continue;
        const mid = V.lerp(nodes[c.nodes[k - 1]].p, nodes[c.nodes[k + 1]].p, 0.5);
        nodes[id].p = V.lerp(nodes[id].p, mid, 0.25);
      }
    }
  }

  // ── Elements ───────────────────────────────────────────────────────────
  const elements = [{ a: iCam, b: iPlate, chain: -1, virtual: true }];
  for (const [ci, c] of chains.entries()) {
    for (let k = 0; k < c.nodes.length - 1; k++) elements.push({ a: c.nodes[k], b: c.nodes[k + 1], chain: ci, virtual: false });
  }

  return { nodes, chains, elements, feet, iCam, iPlate, iHub, iSplit, cone };
}

/**
 * The base ring a ring anchor carries, centred on the flat round face it sits
 * on. A face with no hole in it carries the ring at its rim.
 *
 * @returns {{c, n, R, half, h}} centre on the face, axis, mid radius, half the
 *          radial width, thickness
 */
export function ringOf(a, P) {
  const face = a.rIn > 0 ? a.rOut - a.rIn : Math.min(a.rOut, 0.04);
  const R = a.rOut - face / 2;
  const half = Math.min(Math.max((face * P.ringWidth) / 2, 0.004), R - 0.002);
  return { c: a.p, n: V.norm(a.n), R, half, h: P.ringThickness };
}

/** Air kept between the thickest strut allowed and the camera body. */
const BODY_GAP = 0.006;

/**
 * Distance from a point to the camera body — its drawn solids, or its
 * envelope if it has none — and the direction that leaves it fastest.
 * Negative inside.
 */
export function bodyDistance(camera, p) {
  const rel = V.sub(p, camera.center);
  const q = [V.dot(rel, camera.view), V.dot(rel, camera.right), V.dot(rel, camera.up)];
  const solids = camera.body?.length ? camera.body : [{ c: [0, 0, 0], half: camera.size.map((x) => x / 2), relief: 0 }];
  let best = { d: Infinity, g: [0, 0, 1] };
  for (const b of solids) {
    const e = [0, 1, 2].map((k) => Math.abs(q[k] - b.c[k]) - b.half[k] - (b.relief ?? 0));
    const sign = [0, 1, 2].map((k) => (q[k] >= b.c[k] ? 1 : -1));
    const out = e.map((x) => Math.max(x, 0));
    const outLen = Math.hypot(...out);
    let d, g;
    if (outLen > 0) {
      d = outLen;
      g = out.map((x, k) => (sign[k] * x) / outLen);
    } else {
      const k = e.indexOf(Math.max(...e));
      d = e[k];
      g = [0, 0, 0];
      g[k] = sign[k];
    }
    if (d < best.d) best = { d, g };
  }
  return {
    d: best.d,
    dir: V.add(V.scale(camera.view, best.g[0]), V.add(V.scale(camera.right, best.g[1]), V.scale(camera.up, best.g[2]))),
  };
}

/**
 * Smallest gap between the sized structure and the scan or the camera's view,
 * measured at the nodes. Negative means it intrudes.
 */
export function measureClearance(sk, field) {
  let scan = Infinity;
  let view = Infinity;
  for (const nd of sk.nodes) {
    if (nd.kind === "camera" || nd.kind === "plate" || nd.kind === "hub") continue;
    const nearFoot = sk.feet.reduce((m, f) => Math.min(m, V.dist(nd.p, f.p)), Infinity);
    if (field && nearFoot > 0.16) scan = Math.min(scan, field.sample(nd.p) - nd.r);
    view = Math.min(view, coneClearance(nd.p, sk.cone).d - nd.r);
  }
  return { scan: Number.isFinite(scan) ? scan : null, view: Number.isFinite(view) ? view : null };
}
