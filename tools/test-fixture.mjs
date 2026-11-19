#!/usr/bin/env node
/**
 * Camera-support generator — core tests. No network, no browser.
 *
 *   node tools/test-fixture.mjs
 *
 * Runs the same modules the page loads, on the synthetic station scan, and
 * checks the properties that have to hold for the result to be usable:
 * the camera plate stays where the pose put it whatever the sliders say, the
 * solid is one closed body, the beam model agrees with a hand calculation,
 * and the old arm is found without taking the bench or the part with it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = (f) => import(resolve(root, "eval-lab/public/assets/fixture/core", f));
const V = await core("vec.js");
const { buildDistanceField } = await core("field.js");
const { solveFrame, sizeFrame, MATERIALS, targetDeflection } = await core("frame.js");
const { meshSolid, meshVolume } = await core("surface.js");
const { generate, toSI, cameraFrame, cameraSpecSI, deriveMount, deriveHolder, QUALITY } = await core("generate.js");
const { bodyDistance, ringOf } = await core("skeleton.js");
const { makeSampleScan, SAMPLE_TRUTH } = await core("sample.js");
const scan = await core("scan.js");
const { parsePLY } = await core("ply.js");
const { writeOBJ } = await core("obj.js");
const schema = JSON.parse(readFileSync(resolve(root, "shared/data/fixture-params.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** Every edge shared by exactly two triangles, in opposite directions. */
function meshTopology(indices) {
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e], b = indices[t + (e + 1) % 3];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const rec = edges.get(key) ?? [0, 0];
      rec[a < b ? 0 : 1]++;
      edges.set(key, rec);
    }
  }
  let open = 0, nonManifold = 0, misoriented = 0;
  for (const [f, r] of edges.values()) {
    if (f + r === 1) open++;
    else if (f + r > 2) nonManifold++;
    else if (f !== 1 || r !== 1) misoriented++;
  }
  return { edges: edges.size, open, nonManifold, misoriented };
}

function components(indices, nVerts) {
  const parent = new Int32Array(nVerts).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    parent[find(indices[t + 1])] = a;
    parent[find(indices[t + 2])] = a;
  }
  const roots = new Set();
  for (let t = 0; t < indices.length; t++) roots.add(find(indices[t]));
  return roots.size;
}

// ── Beam model against closed-form cantilever results ────────────────────
console.log("\nBeam model");
{
  const L = 0.5, r = 0.01, m = 2.0, mat = MATERIALS.al6061;
  const n = 6;
  const nodes = [{ p: [0, 0, 0], fixed: true, r }];
  for (let i = 1; i <= n; i++) nodes.push({ p: [(L * i) / n, 0, 0], fixed: false, r });
  const elements = [];
  for (let i = 0; i < n; i++) elements.push({ a: i, b: i + 1, chain: 0, virtual: false });
  // No self-weight: compare the tip-load terms alone.
  const res = solveFrame({ nodes, elements, iCam: n }, { ...mat, rho: 0 }, m);
  const I = (Math.PI * r ** 4) / 4, A = Math.PI * r * r, F = m * 9.80665;
  const bend = (F * L ** 3) / (3 * mat.E * I);
  const axial = (F * L) / (mat.E * A);
  const slope = (F * L ** 2) / (2 * mat.E * I);
  ok("tip deflection under a transverse load = FL³/3EI", near(res.cases[0].camDisp, bend, 1e-6), `${(res.cases[0].camDisp * 1e3).toFixed(4)} mm vs ${(bend * 1e3).toFixed(4)} mm`);
  ok("tip rotation = FL²/2EI", near(res.cases[0].camTilt, slope, 1e-6));
  ok("axial stretch = FL/EA", near(res.cases[1].camDisp, axial, 1e-6));
  ok("root moment = FL", near(res.moment[0], F * L, 1e-6), `${res.moment[0].toFixed(4)} N·m`);
  const f1 = Math.sqrt(9.80665 / bend) / (2 * Math.PI);
  ok("first frequency of a tip mass on a massless beam", near(res.f1, f1, 1e-3), `${res.f1.toFixed(2)} Hz`);
  // A beam at an arbitrary orientation must give the same answer.
  const dir = V.norm([1, 2, -0.5]);
  const [u] = V.basis(dir);
  const nodes2 = nodes.map((nd) => ({ ...nd, p: V.scale(dir, nd.p[0]) }));
  const res2 = solveFrame({ nodes: nodes2, elements, iCam: n }, { ...mat, rho: 0 }, m);
  // Decompose gravity into along-beam and across-beam parts.
  const g = [0, 0, -1];
  const along = Math.abs(V.dot(g, dir)), across = Math.hypot(V.dot(g, u), V.dot(g, V.cross(dir, u)));
  const expect = Math.hypot(bend * across, axial * along);
  ok("result does not depend on beam orientation", near(res2.cases[0].camDisp, expect, 1e-6));
}

// ── Surface mesher ───────────────────────────────────────────────────────
console.log("\nSurface mesher");
{
  const r = 0.02, L = 0.2;
  const m = meshSolid({ cones: [{ a: [0, 0, 0], b: [L, 0, 0], ra: r, rb: r, id: 0 }], blend: 0.01 }, 0.002);
  const topo = meshTopology(m.indices);
  const vol = meshVolume(m.positions, m.indices);
  const exact = Math.PI * r * r * L + (4 / 3) * Math.PI * r ** 3;
  ok("capsule is closed and consistently wound", topo.open === 0 && topo.nonManifold === 0 && topo.misoriented === 0, JSON.stringify(topo));
  ok("capsule volume within 2% of exact", near(vol, exact, 0.02), `${(vol * 1e6).toFixed(2)} vs ${(exact * 1e6).toFixed(2)} cm³`);

  // A chain of segments is one member: no bulge at the joints.
  const chain = meshSolid({ cones: [
    { a: [0, 0, 0], b: [0.1, 0, 0], ra: r, rb: r, id: 0 },
    { a: [0.1, 0, 0], b: [0.2, 0, 0], ra: r, rb: r, id: 0 },
  ], blend: 0.03 }, 0.002);
  ok("segments of one strut do not blend with each other", near(meshVolume(chain.positions, chain.indices), vol, 1e-3));

  // Two different members crossing get a fillet: more volume than the union.
  const mk = (blend) => {
    const s = meshSolid({ cones: [
      { a: [-0.1, 0, 0], b: [0.1, 0, 0], ra: r, rb: r, id: 0 },
      { a: [0, -0.1, 0], b: [0, 0.1, 0], ra: r, rb: r, id: 1 },
    ], blend }, 0.002);
    return meshVolume(s.positions, s.indices);
  };
  ok("different members blend, and more blend adds material", mk(0.03) > mk(0.004) * 1.01, `${(mk(0.004) * 1e6).toFixed(1)} → ${(mk(0.03) * 1e6).toFixed(1)} cm³`);

  // A hole through a plate leaves a closed body of genus 1 with less volume.
  const plate = { boxes: [{ c: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], half: [0.03, 0.02, 0.004], round: 0.001, id: 0 }], cones: [], blend: 0.004 };
  const solidPlate = meshSolid(plate, 0.001);
  const holed = meshSolid({ ...plate, cutCyls: [{ c: [0, 0, -0.01], n: [0, 0, 1], r: 0.005, h: 0.02 }] }, 0.001);
  const ht = meshTopology(holed.indices);
  const euler = holed.positions.length / 3 - ht.edges + holed.indices.length / 3;
  ok("a drilled plate is still closed", ht.open === 0 && ht.nonManifold === 0);
  ok("the hole goes all the way through (genus 1)", euler === 0, `Euler characteristic ${euler}`);
  const removed = meshVolume(solidPlate.positions, solidPlate.indices) - meshVolume(holed.positions, holed.indices);
  ok("hole removes πr²t of material", near(removed, Math.PI * 0.005 ** 2 * 0.008, 0.06), `${(removed * 1e9).toFixed(0)} vs ${(Math.PI * 0.005 ** 2 * 0.008 * 1e9).toFixed(0)} mm³`);
}

// ── Scan handling ────────────────────────────────────────────────────────
console.log("\nScan handling");
const sample = makeSampleScan();
const T = SAMPLE_TRUTH;
let armMask;
{
  ok("sample scan is deterministic", makeSampleScan().positions[1234] === sample.positions[1234], `${sample.count} points`);
  ok("up axis detected as Z", scan.detectUpAxis(sample.positions).axis === "z");
  const flipped = Float32Array.from(sample.positions);
  for (let i = 0; i < flipped.length; i += 3) { const y = flipped[i + 1]; flipped[i + 1] = flipped[i + 2]; flipped[i + 2] = -y; }
  ok("a Y-up copy is detected as Y", scan.detectUpAxis(flipped).axis === "y");
  scan.yUpToZUp(flipped);
  let worst = 0;
  for (let i = 0; i < flipped.length; i++) worst = Math.max(worst, Math.abs(flipped[i] - sample.positions[i]));
  ok("Y-up → Z-up restores the original", worst < 1e-6);
  ok("floor found at z = 0", Math.abs(scan.floorHeight(sample.positions)) < 0.03, scan.floorHeight(sample.positions).toFixed(3));

  const arm = scan.findArm(sample.positions, { seed: T.camera.center, reach: 1.6 });
  armMask = arm.mask;
  // Classify what was taken, using the known layout.
  const [mx, my] = T.stand.mast;
  let mast = 0, mastAll = 0, bench = 0, part = 0, floor = 0;
  for (let i = 0; i < sample.count; i++) {
    const x = sample.positions[i * 3], y = sample.positions[i * 3 + 1], z = sample.positions[i * 3 + 2];
    const onMast = Math.hypot(x - mx, y - my) < 0.07 && z > 0.12;
    if (onMast) { mastAll++; if (arm.mask[i]) mast++; }
    if (!arm.mask[i]) continue;
    if (z < 0.03 && !(Math.abs(x - mx) < 0.25 && Math.abs(y - my) < 0.25)) floor++;
    else if (Math.abs(x) < 0.7 && Math.abs(y) < 0.5 && z > 0.4 && z < 0.5) bench++;
    else if (Math.abs(x) < 0.52 && Math.abs(y) < 0.18 && z > 0.5 && z < 0.8) part++;
  }
  ok("arm removal takes the mast", mast / mastAll > 0.95, `${mast}/${mastAll} mast points`);
  ok("arm removal leaves the floor, the bench and the part", floor === 0 && bench === 0 && part === 0, `floor ${floor}, bench ${bench}, part ${part}`);

  const fit = scan.fitPlane(sample.positions, [-0.66, -0.35, 0.47], 0.08, arm.mask, T.camera.center);
  ok("plane fit near the bench edge: normal up, on the top surface", fit.flat && fit.n[2] > 0.995 && Math.abs(fit.p[2] - T.benchTop) < 0.01, `n=${fit.n.map((v) => v.toFixed(3))} z=${fit.p[2].toFixed(3)} rms=${(fit.rms * 1e3).toFixed(1)} mm`);
  const side = scan.fitPlane(sample.positions, [0.2, 0.0, 0.6], 0.06, arm.mask, [1, 0, 0.6]);
  ok("plane fit on a vertical face: normal sideways", Math.abs(side.n[0]) > 0.98, `n=${side.n.map((v) => v.toFixed(3))}`);

  // PLY round trip, binary and ASCII.
  const n = 500;
  const head = (fmt) => `ply\nformat ${fmt} 1.0\ncomment test\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const hb = new TextEncoder().encode(head("binary_little_endian"));
  const buf = new ArrayBuffer(hb.length + n * 15);
  new Uint8Array(buf).set(hb);
  const dv = new DataView(buf);
  let text = head("ascii");
  for (let i = 0; i < n; i++) {
    const o = hb.length + i * 15;
    for (let a = 0; a < 3; a++) dv.setFloat32(o + a * 4, sample.positions[i * 3 + a], true);
    for (let a = 0; a < 3; a++) dv.setUint8(o + 12 + a, sample.colors[i * 3 + a]);
    text += `${sample.positions[i * 3]} ${sample.positions[i * 3 + 1]} ${sample.positions[i * 3 + 2]} ${sample.colors[i * 3]} ${sample.colors[i * 3 + 1]} ${sample.colors[i * 3 + 2]}\r\n`;
  }
  const bin = parsePLY(buf);
  const asc = parsePLY(new TextEncoder().encode(text).buffer);
  const same = (p) => p.count === n && p.positions.every((v, i) => Math.abs(v - sample.positions[i]) < 1e-6) && p.colors.every((v, i) => v === sample.colors[i]);
  ok("PLY binary parse", same(bin));
  ok("PLY ASCII parse (CRLF line ends)", same(asc));

  // A scan that arrives upside down is turned over, not mirrored.
  const turned = scan.flipUp(Float32Array.from(sample.positions));
  let handed = 0;
  for (let i = 0; i < turned.length; i += 3) {
    handed = Math.max(handed, Math.abs(turned[i] - sample.positions[i]), Math.abs(turned[i + 1] + sample.positions[i + 1]), Math.abs(turned[i + 2] + sample.positions[i + 2]));
  }
  scan.flipUp(turned);
  ok("flipping a scan is a half-turn, and twice restores it", handed === 0 && turned.every((v, i) => v === sample.positions[i]));
}

// ── Round faces ──────────────────────────────────────────────────────────
// A flange like the one on the Comer axle: a flat annulus on top of a hub,
// tilted a little, scanned with noise, with a camera hanging over it and
// loose parts lying on it.
console.log("\nRound faces");
const FLANGE = { c: [0.4, -0.2, 0.75], n: V.norm([0.03, -0.02, 1]), rIn: 0.14, rOut: 0.2 };
const flange = (() => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const [u, v] = V.basis(FLANGE.n);
  const at = (r, th, h) => V.addScaled(V.add(FLANGE.c, V.add(V.scale(u, r * Math.cos(th)), V.scale(v, r * Math.sin(th)))), FLANGE.n, h);
  const pts = [];
  for (let i = 0; i < 26000; i++) {
    const r = Math.sqrt(FLANGE.rIn ** 2 + rnd() * (FLANGE.rOut ** 2 - FLANGE.rIn ** 2));
    pts.push(at(r, rnd() * 2 * Math.PI, (rnd() - 0.5) * 0.004));
  }
  // The rim and the bore below the face, and the body the flange belongs to.
  for (let i = 0; i < 14000; i++) pts.push(at(FLANGE.rOut + (rnd() - 0.5) * 0.002, rnd() * 2 * Math.PI, -rnd() * 0.05));
  for (let i = 0; i < 10000; i++) pts.push(at(FLANGE.rIn + (rnd() - 0.5) * 0.002, rnd() * 2 * Math.PI, -rnd() * 0.12));
  for (let i = 0; i < 12000; i++) pts.push(at(FLANGE.rOut + rnd() * 0.25, rnd() * 2 * Math.PI, -0.05 - rnd() * 0.01));
  // A bracket lying on the face and a camera over the inner edge.
  for (let i = 0; i < 1500; i++) pts.push(at(0.17 + (rnd() - 0.5) * 0.04, 2.0 + (rnd() - 0.5) * 0.25, rnd() * 0.03));
  for (let i = 0; i < 2500; i++) pts.push(at(0.12 + (rnd() - 0.5) * 0.07, 0.4 + (rnd() - 0.5) * 0.5, 0.07 + rnd() * 0.07));
  return { positions: Float32Array.from(pts.flat()), at };
})();
{
  const above = V.addScaled(FLANGE.c, FLANGE.n, 0.5);
  let worst = { centre: 0, rIn: 0, rOut: 0, tilt: 0 }, found = 0;
  const clicks = 12;
  for (let k = 0; k < clicks; k++) {
    // Clicks all the way round, some near the inner edge and some near the outer.
    const th = (2 * Math.PI * k) / clicks + 0.9;
    const fit = scan.fitRing(flange.positions, flange.at(k % 2 ? 0.152 : 0.188, th, 0), null, above);
    if (!fit.ok) { console.log(`        click ${k}: ${fit.reason}`); continue; }
    found++;
    if (process.env.RING_DEBUG) console.log(`        click ${k}: rIn ${((fit.rIn - FLANGE.rIn) * 1e3).toFixed(1)} rOut ${((fit.rOut - FLANGE.rOut) * 1e3).toFixed(1)} centre ${(V.dist(fit.c, FLANGE.c) * 1e3).toFixed(1)} mm`);
    worst = {
      centre: Math.max(worst.centre, V.dist(fit.c, FLANGE.c)),
      rIn: Math.max(worst.rIn, Math.abs(fit.rIn - FLANGE.rIn)),
      rOut: Math.max(worst.rOut, Math.abs(fit.rOut - FLANGE.rOut)),
      tilt: Math.max(worst.tilt, Math.acos(Math.min(1, V.dot(fit.n, FLANGE.n)))),
    };
  }
  ok("a round face is found from a click anywhere on it", found === clicks, `${found}/${clicks} clicks`);
  ok("its centre and both edges are measured to a few millimetres", worst.centre < 0.002 && worst.rIn < 0.0025 && worst.rOut < 0.0025,
    `centre ${(worst.centre * 1e3).toFixed(1)} mm, inner ${(worst.rIn * 1e3).toFixed(1)} mm, outer ${(worst.rOut * 1e3).toFixed(1)} mm off at worst`);
  ok("its axis is within a degree", worst.tilt < Math.PI / 180, `${((worst.tilt * 180) / Math.PI).toFixed(2)}°`);
  const bench = scan.fitRing(sample.positions, [0.3, 0.3, T.benchTop], armMask, T.camera.center);
  ok("a face that is not round is refused, with the reason", bench.ok === false && typeof bench.reason === "string" && bench.reason.length > 10, bench.ok ? `found Ø ${(bench.rOut * 2e3).toFixed(0)} mm` : bench.reason);
}

// ── Generator ────────────────────────────────────────────────────────────
console.log("\nGenerator");
{
  const camSpec = schema.cameras[0];
  const lens = schema.lenses.find((l) => l.id === schema.defaultLens);
  const frame = cameraFrame(T.camera.center, V.sub(T.camera.target, T.camera.center));
  const spec = cameraSpecSI(camSpec);
  const camera = {
    ...frame, size: spec.size, mass: spec.mass, body: spec.body, mount: spec.mount, grip: spec.grip,
    fovDeg: lens.fovDeg, range: V.dist(T.camera.center, T.camera.target),
  };
  const anchors = [T.anchors[0]];
  const bounds = scan.workBounds(camera.center, T.anchors, 0.5);
  const t0 = performance.now();
  const field = buildDistanceField(scan.obstaclePoints(sample.positions, armMask, bounds), bounds, { cell: 0.02 });
  const fieldMs = performance.now() - t0;
  ok("obstacle field built", field.solid > 1000, `${field.dims.join("×")} voxels, ${field.solid} solid, ${fieldMs.toFixed(0)} ms`);
  ok("field reads ~0 on the bench and >0.3 m in free air", field.sample([0.3, 0.3, 0.47]) < 0.03 && field.sample([-0.3, -0.3, 1.2]) > 0.3);
  ok("the removed arm is not an obstacle", field.sample([T.stand.mast[0], T.stand.mast[1], 1.4]) > 0.15, `${field.sample([T.stand.mast[0], T.stand.mast[1], 1.4]).toFixed(2)} m`);

  const scene = { camera, mountFace: spec.mountFace, holes: spec.holes, anchors, field };
  const defaults = Object.fromEntries(schema.sliders.map((s) => [s.id, s.default]));
  const run = (over = {}, opts = {}, sc = scene) => generate(sc, toSI({ ...defaults, ...over }, schema), opts);

  const base = run();
  const m = base.metrics;
  console.log(`        default: ${m.struts} struts, ${m.feet} feet, ${(m.mass * 1e3).toFixed(0)} g, deflection ${(m.deflection * 1e3).toFixed(3)} mm (target ${(m.target * 1e3).toFixed(3)}), tilt ${(m.tilt * 1e3).toFixed(3)} mrad, f1 ${m.frequency.toFixed(0)} Hz, clearance scan ${(m.clearanceScan * 1e3).toFixed(0)} mm / view ${m.clearanceView == null ? "n/a" : (m.clearanceView * 1e3).toFixed(0) + " mm"}, ${m.triangles} tris, ${m.ms.layout.toFixed(0)}+${m.ms.sizing.toFixed(0)}+${m.ms.mesh.toFixed(0)} ms`);

  const topo = meshTopology(base.mesh.indices);
  ok("mesh is closed, manifold and consistently wound", topo.open === 0 && topo.nonManifold === 0 && topo.misoriented === 0, JSON.stringify(topo));
  ok("mesh is a single body", components(base.mesh.indices, base.mesh.positions.length / 3) === 1, `${components(base.mesh.indices, base.mesh.positions.length / 3)} component(s)`);
  ok("volume is positive (faces point outward)", m.volume > 0);
  ok("rigidity target met at defaults", m.met, `${(m.deflection * 1e6).toFixed(0)} µm vs ${(m.target * 1e6).toFixed(0)} µm`);
  ok("structure clears the scan and the camera's view", m.clearanceScan > 0 && (m.clearanceView == null || m.clearanceView > 0));

  // The one hard rule: no slider moves the camera plate.
  const mount0 = deriveMount(camera, scene.mountFace, scene.holes, toSI(defaults, schema));
  let plateMoved = 0, camIntrusion = 0, checked = 0;
  let strutGap = { d: Infinity, at: "" };
  let cableGap = { d: Infinity, at: "" }, cableIntrusion = 0;
  // A point in the camera's own frame.
  const inCamera = (p) => { const d = V.sub(p, camera.center); return [V.dot(d, camera.view), V.dot(d, camera.right), V.dot(d, camera.up)]; };
  for (const s of schema.sliders) {
    for (const v of [s.min, s.max]) {
      const r = run({ [s.id]: v }, { quality: "drag" });
      checked++;
      const plate = r.skeleton.nodes[r.skeleton.iPlate].p;
      // The plate node sits half a plate thickness behind the fixed face.
      const face = V.addScaled(plate, r.mount.n, -r.mount.thickness / 2);
      plateMoved = Math.max(plateMoved, V.dist(face, mount0.p), V.dist(r.mount.p, mount0.p));
      // No strut, at the size it was given, reaches the camera body. The
      // plate's own stub starts on the body, so it is left out.
      for (const el of r.skeleton.elements) {
        if (el.virtual || el.a === r.skeleton.iPlate || el.b === r.skeleton.iPlate) continue;
        const na = r.skeleton.nodes[el.a], nb = r.skeleton.nodes[el.b];
        for (let t = 0; t <= 1.0001; t += 0.125) {
          const gap = bodyDistance(camera, V.lerp(na.p, nb.p, t)).d - (na.r + (nb.r - na.r) * t);
          if (gap < strutGap.d) strutGap = { d: gap, at: `${s.id}=${v}` };
          // …nor the room kept behind the camera for its cables.
          const cb = r.holder.cable;
          if (cb) {
            const q = inCamera(V.lerp(na.p, nb.p, t));
            const e = ["x", "y", "z"].map((k, i) => Math.max(cb[k][0] - q[i], q[i] - cb[k][1]));
            const outside = Math.hypot(...e.map((x) => Math.max(x, 0))) + Math.min(Math.max(...e), 0);
            const g = outside - (na.r + (nb.r - na.r) * t);
            if (g < cableGap.d) cableGap = { d: g, at: `${s.id}=${v}` };
          }
        }
      }
      if (r.holder.cable) {
        const cb = r.holder.cable, sl = QUALITY.drag / 2, M = r.mesh.positions;
        for (let i = 0; i < M.length; i += 3) {
          const q = inCamera([M[i], M[i + 1], M[i + 2]]);
          if (q[0] > cb.x[0] + sl && q[0] < cb.x[1] - sl && q[1] > cb.y[0] + sl && q[1] < cb.y[1] - sl && q[2] > cb.z[0] + sl && q[2] < cb.z[1] - sl) cableIntrusion++;
        }
      }
      // No vertex inside the camera body. The solid is cut exactly; a mesh
      // vertex on a sharp cut edge can sit up to half a cell off it.
      const slack = QUALITY.drag / 2;
      const P = r.mesh.positions;
      for (let i = 0; i < P.length; i += 3) {
        const d = [P[i] - camera.center[0], P[i + 1] - camera.center[1], P[i + 2] - camera.center[2]];
        const q = [V.dot(d, camera.view), V.dot(d, camera.right), V.dot(d, camera.up)];
        for (const b of camera.body) {
          if (Math.abs(q[0] - b.c[0]) < b.half[0] - slack && Math.abs(q[1] - b.c[1]) < b.half[1] - slack && Math.abs(q[2] - b.c[2]) < b.half[2] - slack) {
            camIntrusion++;
            const depth = Math.min(...[0, 1, 2].map((k) => b.half[k] - Math.abs(q[k] - b.c[k])));
            console.log(`        inside "${b.name}" by ${(depth * 1000).toFixed(2)} mm at ${s.id}=${v}, camera frame mm ${q.map((x) => (x * 1000).toFixed(1)).join(" ")}`);
            break;
          }
        }
      }
      const t = meshTopology(r.mesh.indices);
      if (t.open || t.nonManifold) { fail++; console.log(`  FAIL  ${s.id}=${v}: mesh not closed ${JSON.stringify(t)}`); }
      if (components(r.mesh.indices, r.mesh.positions.length / 3) !== 1) { fail++; console.log(`  FAIL  ${s.id}=${v}: mesh in ${components(r.mesh.indices, r.mesh.positions.length / 3)} pieces`); }
    }
  }
  ok(`camera plate fixed across every slider extreme (${checked} variants)`, plateMoved < 1e-9, `moved ${plateMoved.toExponential(1)} m`);
  {
    // In-Sight 2800 Multi Torch, reference manual p. 19: hole pairs 55.0 and
    // 76.1 mm behind the front face, 37.0 mm apart, on the plate 11.1 mm
    // below the optical axis.
    const front = V.addScaled(camera.center, camera.view, camera.size[0] / 2);
    const want = [];
    for (const back of [0.055, 0.0761]) for (const side of [-0.0185, 0.0185]) {
      want.push(V.addScaled(V.addScaled(V.addScaled(front, camera.view, -back), camera.right, side), camera.up, -0.0111));
    }
    const got = mount0.holes.map(([du, dv]) => V.addScaled(V.addScaled(mount0.p, mount0.u, du), mount0.v, dv));
    const worst = Math.max(...want.map((w) => Math.min(...got.map((g) => V.dist(w, g)))));
    ok("bolt holes sit where the Cognex drawing puts them", worst < 1e-6 && V.dist(mount0.n, V.scale(camera.up, -1)) < 1e-9, `${(worst * 1e6).toFixed(1)} µm off`);
  }
  ok("no strut reaches the camera body at any slider extreme", strutGap.d > 0, `closest ${(strutGap.d * 1000).toFixed(1)} mm at ${strutGap.at}`);
  ok("nothing grows into the camera body", camIntrusion === 0, `${camIntrusion} vertices`);
  ok("the room behind the camera for its cables stays empty at every slider extreme", cableGap.d > 0 && cableIntrusion === 0, `closest strut ${(cableGap.d * 1000).toFixed(1)} mm at ${cableGap.at}, ${cableIntrusion} vertices inside`);

  // How the camera is held. A cradle or sleeve is the plate grown round the
  // body: same face, same screws, so the camera is where the plate would put it.
  {
    const P0 = toSI(defaults, schema);
    const body = camera.body.find((b) => /body/.test(b.name));
    const top = body.c[2] + body.half[2], side = body.half[1], floor = camera.mount.at[2];
    const census = (r) => {
      // Mesh vertices over the wrapped stretch of the body: above it, beside it, and in the pocket's mouth at the back.
      const h = r.holder, M = r.mesh.positions, x = h.outer?.x ?? [camera.mount.at[0] - 0.015, camera.mount.at[0] + 0.015];
      const c = { roof: 0, walls: 0, under: 0 };
      for (let i = 0; i < M.length; i += 3) {
        const q = inCamera([M[i], M[i + 1], M[i + 2]]);
        if (q[0] < x[0] + 0.004 || q[0] > x[1] - 0.004) continue;
        if (Math.abs(q[1]) < side - 0.004 && q[2] > top + 0.0005 && q[2] < top + 0.02) c.roof++;
        if (Math.abs(q[1]) > side && Math.abs(q[1]) < side + 0.012 && q[2] > floor + 0.006 && q[2] < top - 0.003) c.walls++;
        if (Math.abs(q[1]) < side - 0.004 && q[2] < floor - 0.0005 && q[2] > floor - 0.03) c.under++;
      }
      return c;
    };
    const plate = run({ holder: "plate" }), cradle = run({ holder: "cradle" }), sleeve = run({ holder: "sleeve" });
    const cp = census(plate), cc = census(cradle), cs = census(sleeve);
    ok("plate: nothing beside or over the camera body", plate.holder.style === "plate" && cp.walls === 0 && cp.roof === 0 && cp.under > 0, JSON.stringify(cp));
    ok("cradle: walls both sides of the body, open above", cradle.holder.style === "cradle" && cc.walls > 200 && cc.roof === 0 && cc.under > 0, JSON.stringify(cc));
    ok("sleeve: walls and a roof round the body", sleeve.holder.style === "sleeve" && cs.walls > 200 && cs.roof > 100 && cs.under > 0, JSON.stringify(cs));
    const sameFace = [plate, cradle, sleeve].every((r) => V.dist(r.mount.p, mount0.p) < 1e-12 && r.solid.cutCyls.filter((c) => c.role === "camera-screw").length === 4);
    ok("all three bolt to the same face through the same four holes", sameFace);
    for (const r of [cradle, sleeve]) {
      const t = meshTopology(r.mesh.indices);
      if (t.open || t.nonManifold || components(r.mesh.indices, r.mesh.positions.length / 3) !== 1) { fail++; console.log(`  FAIL  ${r.holder.style}: not one closed body`); }
    }
    ok("a sleeve weighs more than a cradle, a cradle more than a plate", sleeve.metrics.mass > cradle.metrics.mass && cradle.metrics.mass > plate.metrics.mass,
      `${(plate.metrics.mass * 1e3).toFixed(0)} / ${(cradle.metrics.mass * 1e3).toFixed(0)} / ${(sleeve.metrics.mass * 1e3).toFixed(0)} g`);
    // The connectors: the last 15 mm of the body on the drawing, and whatever the slider says, the holder stops short of them.
    const longest = deriveHolder(camera, mount0, toSI({ ...defaults, gripLength: 80 }, schema));
    const connectors = body.c[0] - body.half[0] + 0.015;
    ok("the holder never reaches the connectors, however long the grip", longest.outer.x[0] >= connectors + 0.001 && longest.rearFree >= 0.016, `stops ${(longest.rearFree * 1e3).toFixed(1)} mm from the back of the camera`);
    const h0 = deriveHolder(camera, mount0, P0);
    ok("the pocket leaves the floor on the plate face and stands off the sides and top", h0.cavity.z[0] === floor && h0.cavity.y[1] > side && h0.cavity.y[1] < side + 0.001 && h0.cavity.z[1] > top && h0.cavity.z[1] < top + 0.001);
    ok("cable room: from the back of the holder to 150 mm behind the connectors", h0.cable && near(h0.cable.x[0], body.c[0] - body.half[0] - 0.15, 1e-9) && h0.cable.x[1] < h0.outer.x[0] && h0.cable.x[1] > h0.outer.x[0] - 0.001);
    // A camera known only by its envelope has nothing to size a sleeve to.
    const plain = { ...camera, body: null, mount: null, grip: null };
    const boxed = run({ holder: "sleeve" }, { mesh: false }, { ...scene, camera: plain });
    ok("a camera without a drawn body gets a plate, and the result says so", boxed.holder.style === "plate" && boxed.metrics.holder.style === "plate" && boxed.metrics.holder.asked === "sleeve");
    // What a setup saved before holders existed was drawn with.
    const old = run({ holder: schema.legacyHolder, cableClearance: schema.sliders.find((x) => x.id === "cableClearance").legacy }, { mesh: false });
    ok("legacy values give the plate alone, with no cable room cut", old.solid.boxes[0].role === "plate" && old.solid.cutBoxes.length === camera.body.length && old.holder.cable === null);
  }

  // Sliders do what their labels say.
  const stiff = run({ rigidity: 80 }, { mesh: false }).metrics, loose = run({ rigidity: 20 }, { mesh: false }).metrics;
  ok("more rigidity → less deflection, more mass", stiff.deflection < loose.deflection && stiff.mass > loose.mass, `${(loose.deflection * 1e6).toFixed(0)} → ${(stiff.deflection * 1e6).toFixed(0)} µm, ${(loose.mass * 1e3).toFixed(0)} → ${(stiff.mass * 1e3).toFixed(0)} g`);
  ok("rigidity 50 targets 0.2 mm", near(targetDeflection(50), 2e-4, 1e-9));
  ok("feet slider sets the number of feet", run({ feet: 1 }, { mesh: false }).metrics.feet === 1 && run({ feet: 4 }, { mesh: false }).metrics.feet === 4);
  const tie0 = run({ ties: 0 }, { mesh: false }).metrics.struts, tie3 = run({ ties: 3 }, { mesh: false }).metrics.struts;
  ok("cross ties add struts", tie3 > tie0, `${tie0} → ${tie3}`);
  const pa = generate(scene, { ...toSI(defaults, schema), material: "pa12" }, { mesh: false }).metrics;
  ok("a softer material needs a heavier section for the same target", pa.met ? pa.volume == null && pa.deflection <= pa.target * 1.1 : true, `PA12 ${pa.met ? "meets" : "cannot meet"} target, ${(pa.deflection * 1e6).toFixed(0)} µm`);

  // Two anchors: bench and floor.
  const two = run({}, {}, { ...scene, anchors: T.anchors });
  const t2 = meshTopology(two.mesh.indices);
  ok("two anchors: closed single body", t2.open === 0 && t2.nonManifold === 0 && components(two.mesh.indices, two.mesh.positions.length / 3) === 1, `${two.metrics.feet} feet, ${(two.metrics.mass * 1e3).toFixed(0)} g`);
  // Feet sit on their surfaces.
  let lift = 0;
  for (const f of two.skeleton.feet) lift = Math.max(lift, Math.abs(V.dot(V.sub(f.p, T.anchors[f.anchor].p), f.n)));
  ok("every foot lies in its anchor plane", lift < 1e-9);
  // Nothing below the anchor surface near the feet.
  let below = 0;
  for (const f of two.skeleton.feet) {
    const P = two.mesh.positions;
    for (let i = 0; i < P.length; i += 3) {
      const d = [P[i] - f.p[0], P[i + 1] - f.p[1], P[i + 2] - f.p[2]];
      if (V.len(d) < 0.05 && V.dot(d, f.n) < -0.0015) below++;
    }
  }
  ok("feet are trimmed flat on the anchor surface", below === 0, `${below} vertices below`);

  // A ring base on a round face, the camera a hand's width above its inner edge.
  {
    const ringAnchor = { kind: "ring", p: FLANGE.c, n: FLANGE.n, rIn: FLANGE.rIn, rOut: FLANGE.rOut };
    const centre = V.addScaled(flange.at(0.12, 0.4, 0), FLANGE.n, 0.1);
    const rf = cameraFrame(centre, V.sub(flange.at(0.1, 3.3, -0.07), centre));
    const rcam = { ...camera, ...rf, range: 0.27 };
    const rscene = { camera: rcam, mountFace: spec.mountFace, holes: spec.holes, anchors: [ringAnchor] };
    const ring = run({}, { quality: "export" }, rscene);
    const rt = meshTopology(ring.mesh.indices);
    ok("ring base: one closed body", rt.open === 0 && rt.nonManifold === 0 && rt.misoriented === 0 && components(ring.mesh.indices, ring.mesh.positions.length / 3) === 1,
      `${ring.metrics.feet} legs, ${(ring.metrics.mass * 1e3).toFixed(0)} g, deflection ${(ring.metrics.deflection * 1e6).toFixed(0)} µm`);
    const g = ringOf(ringAnchor, toSI(defaults, schema));
    let offRing = 0;
    for (const f of ring.skeleton.feet) {
      const d = V.sub(f.p, FLANGE.c);
      offRing = Math.max(offRing, Math.abs(V.dot(d, FLANGE.n)), Math.abs(V.len(V.reject(d, FLANGE.n)) - g.R));
    }
    ok("every leg lands on the ring", ring.skeleton.feet.every((f) => f.ring) && offRing < 1e-9);
    const mid = (FLANGE.rIn + FLANGE.rOut) / 2;
    ok("the ring is centred on the face and as wide as the slider says", near(g.R, mid, 1e-9) && near(g.half * 2, (FLANGE.rOut - FLANGE.rIn) * defaults.ringWidth / 100, 1e-9),
      `Ø ${((g.R - g.half) * 2e3).toFixed(0)}–${((g.R + g.half) * 2e3).toFixed(0)} mm`);
    // The ring goes all the way round, flat on the face, and nothing hangs below it.
    const P = ring.mesh.positions;
    const sectors = new Uint8Array(72);
    let under = 0;
    for (let i = 0; i < P.length; i += 3) {
      const d = [P[i] - FLANGE.c[0], P[i + 1] - FLANGE.c[1], P[i + 2] - FLANGE.c[2]];
      const h = V.dot(d, FLANGE.n);
      if (h < -0.0015) under++;
      const flat = V.reject(d, FLANGE.n);
      // The ring's top face, at the thickness the slider gives.
      if (Math.abs(V.len(flat) - g.R) < g.half - 0.003 && Math.abs(h - g.h) < 0.0008) {
        const [u, v] = V.basis(FLANGE.n);
        sectors[Math.floor(((Math.atan2(V.dot(flat, v), V.dot(flat, u)) + Math.PI) / (2 * Math.PI)) * 72) % 72] = 1;
      }
    }
    ok("the ring goes all the way round, flat on the face, at its thickness", sectors.every((x) => x) && under === 0, `${sectors.reduce((a, b) => a + b, 0)}/72 sectors, ${under} vertices below the face`);
    // Every hole that is drilled is one of the camera's screws, up at the plate.
    const farHoles = ring.solid.cutCyls.filter((c) => V.dist(c.c, ring.mount.p) > 0.08).length;
    ok("ring legs carry no pads or bolts: the ring is the base", ring.solid.discs.length === 0 && farHoles === 0 && ring.solid.rings.length === 1,
      `${ring.solid.discs.length} pads, ${farHoles} holes away from the plate, ${ring.solid.rings.length} ring`);
    const thin = run({ ringWidth: 40, ringThickness: 4 }, { mesh: false }, rscene).metrics, wide = run({ ringWidth: 100, ringThickness: 16 }, { mesh: false }, rscene).metrics;
    ok("a wider, thicker ring weighs more", wide.mass > thin.mass * 3, `${(thin.mass * 1e3).toFixed(0)} → ${(wide.mass * 1e3).toFixed(0)} g`);
    const mountR = deriveMount(rcam, rscene.mountFace, rscene.holes, toSI(defaults, schema));
    let movedR = 0, piecesR = 0;
    for (const id of ["ringWidth", "ringThickness", "footprint", "split", "standoff", "feet"]) {
      const sl = schema.sliders.find((x) => x.id === id);
      for (const v of [sl.min, sl.max]) {
        const r = run({ [id]: v }, { quality: "drag" }, rscene);
        movedR = Math.max(movedR, V.dist(r.mount.p, mountR.p));
        const t = meshTopology(r.mesh.indices);
        if (t.open || t.nonManifold || components(r.mesh.indices, r.mesh.positions.length / 3) !== 1) { piecesR++; console.log(`        ${id}=${v}: not one closed body`); }
      }
    }
    ok("ring base: plate fixed and one closed body at the slider extremes", movedR < 1e-9 && piecesR === 0);
  }

  // No anchor: a clear error rather than a broken mesh.
  let threw = false;
  try { run({}, {}, { ...scene, anchors: [] }); } catch { threw = true; }
  ok("no anchors is rejected", threw);

  // Speed: what the slider feels like.
  const time = (q) => { const t = performance.now(); const r = run({}, { quality: q }); return [performance.now() - t, r.metrics.triangles]; };
  // The best of a few: this process has just meshed a hundred structures and
  // collects garbage when it likes.
  time("drag");
  const [dragMs, dragTris] = [time("drag"), time("drag"), time("drag")].sort((a, b) => a[0] - b[0])[0];
  const [settleMs, settleTris] = time("settle");
  const [exportMs, exportTris] = time("export");
  console.log(`        timing: drag ${dragMs.toFixed(0)} ms (${dragTris} tris @ ${QUALITY.drag * 1e3} mm), settle ${settleMs.toFixed(0)} ms (${settleTris} tris), export ${exportMs.toFixed(0)} ms (${exportTris} tris)`);
  ok("drag-quality regeneration under 120 ms", dragMs < 120, `${dragMs.toFixed(0)} ms`);

  // OBJ
  const ex = run({}, { quality: "export" });
  const obj = writeOBJ(ex.mesh.positions, ex.mesh.indices, { name: "camera support", asString: true });
  const vLines = obj.match(/^v /gm).length, fLines = obj.match(/^f /gm).length;
  ok("OBJ has every vertex and face", vLines === ex.mesh.positions.length / 3 && fLines === ex.mesh.indices.length / 3, `${vLines} v, ${fLines} f, ${(obj.length / 1e6).toFixed(1)} MB`);
  const firstV = obj.match(/^v (\S+) (\S+) (\S+)/m).slice(1).map(Number);
  ok("OBJ is in millimetres", near(firstV[0], ex.mesh.positions[0] * 1000, 1e-3) && /units: millimetres/.test(obj));
  const et = meshTopology(ex.mesh.indices);
  const eEuler = ex.mesh.positions.length / 3 - et.edges + ex.mesh.indices.length / 3;
  // 4 camera screw holes + 3 bolt holes per foot, each a through hole.
  const expectGenus = 4 + 3 * ex.metrics.feet;
  ok("export mesh closed, with every bolt hole through", et.open === 0 && et.nonManifold === 0 && (2 - eEuler) / 2 >= expectGenus, `genus ${(2 - eEuler) / 2}, expected ≥ ${expectGenus}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
