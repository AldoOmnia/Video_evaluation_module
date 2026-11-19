/**
 * STEP export worker — builds a B-rep solid of the camera support.
 *
 * Runs in a worker thread, started by services/fixtureStep.ts, for two reasons:
 * the CAD kernel takes tens of seconds on a branched structure and would stall
 * every other request if it ran on the server's event loop; and a thread that
 * exits hands the kernel's memory back.
 *
 * Plain .mjs on purpose. It is loaded by path at runtime in both `tsx` dev and
 * the compiled build, so it must not need compiling.
 *
 * Input (workerData.solid) is the same description the browser meshes for the
 * OBJ — struts as tapered segments grouped into members, the camera plate, foot
 * pads, bolt holes and the cuts — in metres. Output is AP242 STEP in
 * millimetres.
 *
 * What the STEP is, and is not: each member becomes one smooth lofted surface
 * through its sections, members are joined with a sphere at every shared node,
 * and the plate, pads and holes are exact analytic geometry. The soft blends
 * of the mesh are NOT reproduced — fillets across freeform junctions are where
 * CAD kernels fail unpredictably, and a file that sometimes cannot be written
 * is worse than one with plain joints that NX can fillet itself.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mm = (p) => [p[0] * 1000, p[1] * 1000, p[2] * 1000];

async function build(solid) {
  const { default: opencascade } = await import("replicad-opencascadejs");
  const OC = await opencascade({ wasmBinary: readFileSync(require.resolve("replicad-opencascadejs/wasm")) });
  const r = await import("replicad");
  r.setOC(OC);

  const report = { members: 0, lofted: 0, segmented: 0, fuseFailures: 0, retries: 0, cutFailures: 0, holes: 0, rings: 0 };
  const circle = (p, rad, normal, x) => r.sketchCircle(rad, { plane: new r.Plane(p, x, normal) });
  const frustum = (a, b, ra, rb) => {
    const d = sub(b, a);
    return circle(a, ra, d, null).loftWith(circle(b, rb, d, null), { ruled: true });
  };
  const slab = (b) => {
    const origin = sub(mm(b.c), scale(b.n, b.half[2] * 1000));
    return r.sketchRectangle(b.half[0] * 2000, b.half[1] * 2000, { plane: new r.Plane(origin, b.u, b.n) }).extrude(b.half[2] * 2000);
  };

  // Regroup the segments into members: consecutive segments with one id.
  const members = new Map();
  for (const c of solid.cones) {
    const m = members.get(c.id) ?? [];
    if (m.length === 0) m.push({ p: mm(c.a), r: c.ra * 1000 });
    m.push({ p: mm(c.b), r: c.rb * 1000 });
    members.set(c.id, m);
  }

  // Parts to join, each { shape, filler?, fallback? }. A filler is expected to
  // sit almost wholly inside what is already there. A fallback rebuilds a
  // lofted member segment by segment if the loft will not join.
  const lofts = [], straights = [];
  const segments = (m) => {
    const out = [];
    for (let i = 0; i < m.length - 1; i++) {
      out.push({ shape: frustum(m[i].p, m[i + 1].p, m[i].r, m[i + 1].r) });
      // 3% over size: a sphere exactly tangent to the frustum ends makes
      // the boolean fail.
      if (i > 0) out.push({ shape: r.makeSphere(m[i].r * 1.03).translate(m[i].p), filler: true });
    }
    return out;
  };
  const ends = new Map();
  const key = (p) => p.map((x) => Math.round(x * 100)).join(",");
  for (const m of members.values()) {
    report.members++;
    let shape = null;
    if (m.length >= 3) {
      try {
        const tangent = m.map((_, i) => unit(sub(m[Math.min(i + 1, m.length - 1)].p, m[Math.max(i - 1, 0)].p)));
        // Carry one reference direction down the member so the section seams
        // line up; otherwise the loft twists.
        let x = unit(cross(tangent[0], Math.abs(tangent[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
        const sections = m.map((n, i) => {
          x = unit(sub(x, scale(tangent[i], dot(x, tangent[i]))));
          return circle(n.p, n.r, tangent[i], x);
        });
        shape = sections[0].loftWith(sections.slice(1), { ruled: false });
        // A member that turns sharply over a few millimetres lofts into a
        // surface that crosses itself, which the kernel returns without
        // complaint and with a nonsense (even negative) volume. The member's
        // volume is known from its segments; a loft that is not close to it is
        // discarded and the member is built segment by segment instead.
        let expect = 0;
        for (let i = 0; i < m.length - 1; i++) {
          const L = Math.hypot(...sub(m[i + 1].p, m[i].p));
          expect += (Math.PI / 3) * L * (m[i].r ** 2 + m[i].r * m[i + 1].r + m[i + 1].r ** 2);
        }
        const got = r.measureVolume(shape);
        if (!(got > expect * 0.7 && got < expect * 1.3)) shape = null;
        else report.lofted++;
      } catch {
        shape = null;
      }
    }
    if (shape) lofts.push({ shape, fallback: () => segments(m) });
    else {
      report.segmented++;
      straights.push(...segments(m));
    }
    for (const n of [m[0], m[m.length - 1]]) {
      const e = ends.get(key(n.p)) ?? { p: n.p, r: 0, uses: 0 };
      e.r = Math.max(e.r, n.r);
      e.uses++;
      ends.set(key(n.p), e);
    }
  }
  // A knuckle wherever members meet, so they overlap in volume rather than
  // touching along an edge. The knuckles go in before the straight members:
  // two ties ending on one node have end caps of the same radius about the
  // same point, which touch at exactly two points — a contact the kernel
  // cannot resolve. With the knuckle already there, both caps are buried.
  // The plate goes first, while what it joins is still simple: late in the
  // sequence the same join has been seen to return the plate alone.
  const parts = (solid.boxes ?? []).map((b) => ({ shape: slab(b) }));
  parts.push(...lofts);
  for (const e of ends.values()) if (e.uses >= 2) parts.push({ shape: r.makeSphere(e.r * 1.03).translate(e.p), filler: true });
  parts.push(...straights);
  for (const d of solid.discs ?? []) parts.push({ shape: r.makeCylinder(d.r * 1000, d.h * 1000, mm(d.c), d.n) });
  for (const g of solid.rings ?? []) {
    const outer = r.makeCylinder((g.R + g.half) * 1000, g.h * 1000, mm(g.c), g.n);
    const bore = (g.R - g.half) * 1000;
    // The bore runs a millimetre past both faces so the cut is clean.
    parts.push({ shape: bore > 0.5 ? outer.cut(r.makeCylinder(bore, g.h * 1000 + 2, sub(mm(g.c), scale(g.n, 1)), g.n)) : outer });
    report.rings++;
  }

  // The kernel's boolean does not always throw when it fails: now and then a
  // fuse returns an empty or partial shape, or the body with the new part
  // left out. The volume says whether it worked: a union is at least as big
  // as its larger operand and no bigger than both together, and where it
  // added little, the overlap is measured to tell a part that really was
  // mostly inside from one that was dropped. A join that did not work is
  // retried with the part moved by hundredths of a millimetre, which is
  // enough to get it off whatever coincidence tripped the kernel; a lofted
  // member that still will not join is rebuilt from straight segments.
  const volume = (s) => { try { return r.measureVolume(s); } catch { return NaN; } };
  const NUDGES = [null, [0.02, 0.014, 0.008], [-0.03, 0.02, -0.012], [0.05, -0.035, 0.02]];
  let body = null, bodyV = 0;
  const worked = (shape, partV, v, filler) => {
    if (!(v >= Math.max(bodyV, partV) * 0.999 && v <= (bodyV + partV) * 1.001)) return false;
    if (filler || v - bodyV >= partV * 0.25) return true;
    const common = volume(body.intersect(shape));
    return Math.abs(bodyV + partV - common - v) <= partV * 0.05 + 1;
  };
  const queue = parts.slice();
  while (queue.length) {
    const p = queue.shift();
    const partV = volume(p.shape);
    let joined = null;
    if (!body) {
      if (partV > 0) joined = { out: p.shape, v: partV };
    } else if (partV > 0) {
      for (const nudge of NUDGES) {
        try {
          const shape = nudge ? p.shape.clone().translate(nudge) : p.shape;
          const out = body.fuse(shape);
          const v = volume(out);
          if (worked(shape, partV, v, p.filler)) { joined = { out, v }; break; }
        } catch { /* try the next nudge */ }
        report.retries++;
      }
    }
    if (joined) { body = joined.out; bodyV = joined.v; }
    else if (p.fallback) {
      report.lofted--;
      report.segmented++;
      queue.unshift(...p.fallback());
    } else report.fuseFailures++;
  }
  if (!body) throw new Error("nothing to build");

  const tools = [];
  for (const pl of solid.cutPlanes ?? []) {
    tools.push(r.makeCylinder(pl.r * 1000, pl.r * 1000, sub(mm(pl.p), scale(pl.n, pl.r * 1000)), pl.n));
  }
  for (const b of solid.cutBoxes ?? []) tools.push(slab(b));
  for (const c of solid.cutCyls ?? []) {
    tools.push(r.makeCylinder(c.r * 1000, c.h * 1000, mm(c.c), c.n));
    if (c.role === "camera-screw" || c.role === "foot-bolt") report.holes++;
  }
  // One cut at a time. The tools overlap (the pocket lies inside the camera's
  // keep-out, a screw hole inside its access channel) and the kernel's cut by
  // a compound assumes they do not: it left the doubly covered pieces behind
  // as loose bodies. A cut can only take material away, so one that adds any
  // is thrown out and counted.
  for (const tool of tools) {
    try {
      const before = r.measureVolume(body);
      const next = body.cut(tool);
      const after = r.measureVolume(next);
      if (!(after > 0) || after > before * (1 + 1e-6)) throw new Error("cut added material");
      body = next;
    } catch {
      report.cutFailures++;
    }
  }

  report.volumeMm3 = r.measureVolume(body);
  const bytes = new Uint8Array(await body.blobSTEP().arrayBuffer());
  // One closed solid is the only acceptable outcome; count what was written.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  report.solids = (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length;
  return { bytes, report };
}

// The kernel prints transfer statistics to stdout; keep them out of the
// server log.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
try {
  const { bytes, report } = await build(workerData.solid);
  process.stdout.write = write;
  parentPort.postMessage({ ok: true, bytes, report }, [bytes.buffer]);
} catch (err) {
  process.stdout.write = write;
  parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
}
