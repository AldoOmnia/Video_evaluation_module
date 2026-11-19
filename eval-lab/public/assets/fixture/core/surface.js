/**
 * Implicit surface → triangle mesh.
 *
 * The sized skeleton is turned into a signed distance field — round cones for
 * struts, a box for the camera plate, discs for the foot flanges, a flat ring
 * for a base that sits on a round face — and blended
 * where separate members meet, which is what gives the organic webbed joints.
 * Bolt holes and the camera body are then subtracted, and the zero level set is
 * meshed with naive surface nets.
 *
 * Two things keep this fast enough to follow a slider:
 *   - The field is evaluated one Z layer at a time and only inside each
 *     primitive's bounding box, so memory is two layers regardless of
 *     resolution and work scales with the structure, not its bounding volume.
 *   - Blending uses the two nearest *different* members per sample rather than
 *     a sum over all primitives. Consecutive segments of one strut therefore
 *     never blend with each other, which is what would otherwise bead the
 *     strut at every node.
 */

const BIG = 1e6;
/** Smallest hole radius the mesher will cut, in cells. */
export const MIN_HOLE_CELLS = 1.5;

/** Signed distance to a cone with spherical ends (Quilez's round cone). */
function sdRoundCone(px, py, pz, c) {
  const pax = px - c.ax, pay = py - c.ay, paz = pz - c.az;
  const y = pax * c.bax + pay * c.bay + paz * c.baz;
  const z = y - c.l2;
  const qx = pax * c.l2 - c.bax * y, qy = pay * c.l2 - c.bay * y, qz = paz * c.l2 - c.baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * c.l2, z2 = z * z * c.l2;
  const k = c.sgn * c.rr * c.rr * x2;
  if (Math.sign(z) * c.a2 * z2 > k) return Math.sqrt(x2 + z2) * c.il2 - c.rb;
  if (Math.sign(y) * c.a2 * y2 < k) return Math.sqrt(x2 + y2) * c.il2 - c.ra;
  return (Math.sqrt(x2 * c.a2 * c.il2) + y * c.rr) * c.il2 - c.ra;
}

/** Signed distance to an oriented box with rounded edges. */
function sdBox(px, py, pz, b) {
  const dx = px - b.c[0], dy = py - b.c[1], dz = pz - b.c[2];
  const qx = Math.abs(dx * b.u[0] + dy * b.u[1] + dz * b.u[2]) - b.half[0] + b.round;
  const qy = Math.abs(dx * b.v[0] + dy * b.v[1] + dz * b.v[2]) - b.half[1] + b.round;
  const qz = Math.abs(dx * b.n[0] + dy * b.n[1] + dz * b.n[2]) - b.half[2] + b.round;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - b.round;
}

/** Signed distance to a capped cylinder from `c` along unit `n` for length `h`. */
function sdCylinder(px, py, pz, c) {
  const dx = px - c.c[0], dy = py - c.c[1], dz = pz - c.c[2];
  const t = dx * c.n[0] + dy * c.n[1] + dz * c.n[2];
  const rx = dx - t * c.n[0], ry = dy - t * c.n[1], rz = dz - t * c.n[2];
  const dr = Math.hypot(rx, ry, rz) - c.r;
  const dh = Math.abs(t - c.h / 2) - c.h / 2;
  return Math.min(Math.max(dr, dh), 0) + Math.hypot(Math.max(dr, 0), Math.max(dh, 0));
}

/**
 * Signed distance to a flat ring: an annulus of mid radius `R` and radial
 * half-width `half` about the axis `n` through `c`, from the plane of `c` up
 * to height `h`, with rounded edges.
 */
function sdRing(px, py, pz, g) {
  const dx = px - g.c[0], dy = py - g.c[1], dz = pz - g.c[2];
  const t = dx * g.n[0] + dy * g.n[1] + dz * g.n[2];
  const rho = Math.hypot(dx - t * g.n[0], dy - t * g.n[1], dz - t * g.n[2]);
  const qx = Math.abs(rho - g.R) - g.half + g.round;
  const qy = Math.abs(t - g.h / 2) - g.h / 2 + g.round;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - g.round;
}

function prepCone(c) {
  const bax = c.b[0] - c.a[0], bay = c.b[1] - c.a[1], baz = c.b[2] - c.a[2];
  const l2 = Math.max(bax * bax + bay * bay + baz * baz, 1e-12);
  // The formula needs the radii to differ by less than the length; a short
  // segment between very different radii is fattened at its thin end.
  const lim = 0.9 * Math.sqrt(l2);
  let ra = c.ra, rb = c.rb;
  if (ra - rb > lim) rb = ra - lim;
  if (rb - ra > lim) ra = rb - lim;
  const rr = ra - rb;
  return {
    ax: c.a[0], ay: c.a[1], az: c.a[2], bax, bay, baz, l2, rr,
    a2: l2 - rr * rr, il2: 1 / l2, sgn: Math.sign(rr), ra, rb, id: c.id,
    lo: [0, 1, 2].map((k) => Math.min(c.a[k] - ra, c.b[k] - rb)),
    hi: [0, 1, 2].map((k) => Math.max(c.a[k] + ra, c.b[k] + rb)),
  };
}

function boxBounds(b) {
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const e = Math.abs(b.u[k]) * b.half[0] + Math.abs(b.v[k]) * b.half[1] + Math.abs(b.n[k]) * b.half[2];
    lo[k] = b.c[k] - e;
    hi[k] = b.c[k] + e;
  }
  return { lo, hi };
}

function cylBounds(c) {
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const end = c.c[k] + c.n[k] * c.h;
    const e = c.r * Math.sqrt(Math.max(0, 1 - c.n[k] * c.n[k]));
    lo[k] = Math.min(c.c[k], end) - e;
    hi[k] = Math.max(c.c[k], end) + e;
  }
  return { lo, hi };
}

const ringBounds = (g) => cylBounds({ c: g.c, n: g.n, r: g.R + g.half, h: g.h });

/**
 * Drop everything that is not part of the body.
 *
 * Where members bundle closely the blend can seal off a pocket between them,
 * which meshes as a closed bubble inside the part — a void that cannot be
 * machined and traps powder when printed. Bubbles have inward-facing surfaces
 * (negative volume) and are removed, which fills them. Specks a few cells
 * across are removed too. Anything larger that is separate is kept and
 * counted in `pieces`, so a design that has genuinely come apart is reported
 * rather than hidden.
 */
function keepBodies(pos, nv, idx, ni) {
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let t = 0; t < ni; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  const vol = new Float64Array(nv);
  for (let t = 0; t < ni; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol[find(idx[t])] += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  let biggest = 0;
  for (let i = 0; i < nv; i++) if (parent[i] === i && vol[i] > biggest) biggest = vol[i];
  let pieces = 0;
  const keepRoot = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) {
    if (parent[i] !== i || !(vol[i] > 0)) continue;
    if (vol[i] >= biggest * 0.002) { keepRoot[i] = 1; pieces++; }
  }
  const remap = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let i = 0; i < nv; i++) if (keepRoot[find(i)]) remap[i] = n++;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < nv; i++) {
    const m = remap[i];
    if (m < 0) continue;
    positions[m * 3] = pos[i * 3]; positions[m * 3 + 1] = pos[i * 3 + 1]; positions[m * 3 + 2] = pos[i * 3 + 2];
  }
  let m = 0;
  const indices = new Uint32Array(ni);
  for (let t = 0; t < ni; t += 3) {
    if (remap[idx[t]] < 0) continue;
    indices[m++] = remap[idx[t]]; indices[m++] = remap[idx[t + 1]]; indices[m++] = remap[idx[t + 2]];
  }
  return { positions, indices: indices.slice(0, m), pieces };
}

/**
 * @param {object} solid
 * @param {Array}  solid.cones     [{a, b, ra, rb, id}]  struts; equal `id` = same member
 * @param {Array}  solid.boxes     [{c, u, v, n, half, round, id}]  added
 * @param {Array}  solid.discs     [{c, n, r, h, id}]  added
 * @param {Array}  solid.rings     [{c, n, R, half, h, round, id}]  added
 * @param {Array}  solid.cutCyls   [{c, n, r, h}]  subtracted
 * @param {Array}  solid.cutBoxes  [{c, u, v, n, half, round}]  subtracted
 * @param {Array}  solid.cutPlanes [{p, n, r}]  material behind the plane, within r of p, subtracted
 * @param {number} solid.blend     fillet size between different members, metres
 * @param {number} cell            grid spacing, metres
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array, cell: number, pieces: number, skippedHoles: number}}
 */
export function meshSolid(solid, cell) {
  const k = Math.max(solid.blend, cell * 0.5);
  const pad = k + cell * 2;

  // Additive primitives share one list so each layer pass is a single loop.
  const adds = [];
  for (const c of solid.cones) { const p = prepCone(c); adds.push({ kind: 0, p, lo: p.lo, hi: p.hi, id: c.id }); }
  for (const b of solid.boxes ?? []) adds.push({ kind: 1, p: b, ...boxBounds(b), id: b.id });
  for (const d of solid.discs ?? []) adds.push({ kind: 2, p: d, ...cylBounds(d), id: d.id });
  for (const g of solid.rings ?? []) adds.push({ kind: 4, p: g, ...ringBounds(g), id: g.id });
  if (adds.length === 0) return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), cell, pieces: 0, skippedHoles: 0 };

  // A hole narrower than about three cells cannot be represented and would
  // only leave ragged pits, so it is left out at this resolution and appears
  // once the mesh is fine enough.
  const cuts = [];
  let skippedHoles = 0;
  for (const c of solid.cutCyls ?? []) {
    if (c.r < cell * MIN_HOLE_CELLS) { skippedHoles++; continue; }
    cuts.push({ kind: 2, p: c, ...cylBounds(c) });
  }
  for (const b of solid.cutBoxes ?? []) cuts.push({ kind: 1, p: b, ...boxBounds(b) });
  for (const pl of solid.cutPlanes ?? []) {
    cuts.push({ kind: 3, p: pl, lo: pl.p.map((x) => x - pl.r), hi: pl.p.map((x) => x + pl.r) });
  }

  const min = [BIG, BIG, BIG], max = [-BIG, -BIG, -BIG];
  for (const a of adds) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], a.lo[i] - pad);
    max[i] = Math.max(max[i], a.hi[i] + pad);
  }
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const layer = nx * ny;

  const toIdx = (x, axis, n, up) => {
    const f = (x - min[axis]) / cell;
    return Math.max(0, Math.min(n - 1, up ? Math.ceil(f) : Math.floor(f)));
  };
  for (const a of adds) {
    a.i0 = toIdx(a.lo[0] - pad, 0, nx, false); a.i1 = toIdx(a.hi[0] + pad, 0, nx, true);
    a.j0 = toIdx(a.lo[1] - pad, 1, ny, false); a.j1 = toIdx(a.hi[1] + pad, 1, ny, true);
    a.k0 = toIdx(a.lo[2] - pad, 2, nz, false); a.k1 = toIdx(a.hi[2] + pad, 2, nz, true);
  }
  for (const c of cuts) {
    c.i0 = toIdx(c.lo[0] - cell, 0, nx, false); c.i1 = toIdx(c.hi[0] + cell, 0, nx, true);
    c.j0 = toIdx(c.lo[1] - cell, 1, ny, false); c.j1 = toIdx(c.hi[1] + cell, 1, ny, true);
    c.k0 = toIdx(c.lo[2] - cell, 2, nz, false); c.k1 = toIdx(c.hi[2] + cell, 2, nz, true);
  }

  const d1 = new Float32Array(layer), d2 = new Float32Array(layer);
  const id1 = new Int32Array(layer);

  // Only the part of each layer that a primitive can reach is touched. A
  // layer buffer remembers the rectangle it last wrote so it can be reset
  // without sweeping the whole array.
  const makeLayer = () => ({ f: new Float32Array(layer).fill(BIG), v: new Int32Array(layer).fill(-1), r: null, vr: null });
  const fillRect = (arr, r, value) => {
    if (!r) return;
    for (let j = r[2]; j <= r[3]; j++) arr.fill(value, r[0] + nx * j, r[1] + nx * j + 1);
  };

  function evalLayer(kz, buf) {
    const out = buf.f;
    fillRect(out, buf.r, BIG);
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    for (const a of adds) {
      if (kz < a.k0 || kz > a.k1) continue;
      if (a.i0 < i0) i0 = a.i0;
      if (a.i1 > i1) i1 = a.i1;
      if (a.j0 < j0) j0 = a.j0;
      if (a.j1 > j1) j1 = a.j1;
    }
    if (i1 < 0) { buf.r = null; return; }
    const rect = (buf.r = [i0, i1, j0, j1]);
    fillRect(d1, rect, BIG);
    fillRect(d2, rect, BIG);
    fillRect(id1, rect, -1);

    const pz = min[2] + kz * cell;
    for (const a of adds) {
      if (kz < a.k0 || kz > a.k1) continue;
      const { kind, p, id } = a;
      for (let j = a.j0; j <= a.j1; j++) {
        const py = min[1] + j * cell;
        let o = a.i0 + nx * j;
        for (let i = a.i0; i <= a.i1; i++, o++) {
          const px = min[0] + i * cell;
          const d = kind === 0 ? sdRoundCone(px, py, pz, p) : kind === 1 ? sdBox(px, py, pz, p) : kind === 4 ? sdRing(px, py, pz, p) : sdCylinder(px, py, pz, p);
          if (id === id1[o]) {
            if (d < d1[o]) d1[o] = d;
          } else if (d < d1[o]) {
            d2[o] = d1[o];
            d1[o] = d;
            id1[o] = id;
          } else if (d < d2[o]) {
            d2[o] = d;
          }
        }
      }
    }
    for (let j = j0; j <= j1; j++) {
      let o = i0 + nx * j;
      for (let i = i0; i <= i1; i++, o++) {
        const a = d1[o];
        const h = k - (d2[o] - a);
        out[o] = h > 0 ? a - (h * h) / (4 * k) : a;
      }
    }
    for (const c of cuts) {
      if (kz < c.k0 || kz > c.k1) continue;
      const { kind, p } = c;
      const ci0 = Math.max(c.i0, i0), ci1 = Math.min(c.i1, i1);
      for (let j = Math.max(c.j0, j0); j <= Math.min(c.j1, j1); j++) {
        const py = min[1] + j * cell;
        let o = ci0 + nx * j;
        for (let i = ci0; i <= ci1; i++, o++) {
          const px = min[0] + i * cell;
          let d;
          if (kind === 3) {
            const dx = px - p.p[0], dy = py - p.p[1], dz = pz - p.p[2];
            const t = dx * p.n[0] + dy * p.n[1] + dz * p.n[2];
            // Only trim near the foot: the plane is a local fit, not the
            // whole surface, and must not slice the structure elsewhere.
            if (Math.hypot(dx - t * p.n[0], dy - t * p.n[1], dz - t * p.n[2]) > p.r || t < -p.r) continue;
            d = t;
          } else {
            d = kind === 1 ? sdBox(px, py, pz, p) : sdCylinder(px, py, pz, p);
          }
          if (-d > out[o]) out[o] = -d;
        }
      }
    }
  }

  // Surface nets puts one vertex in each cell the surface passes through. Two
  // sign patterns make that vertex serve two separate sheets of surface and
  // leave an edge with four faces on it: a cell face whose corners alternate
  // in/out, and a cell whose only two like corners are diagonally opposite.
  // Both mean the surface has a feature thinner than a cell there. Nudging one
  // corner across zero resolves it, at the cost of moving the surface by less
  // than a cell at that spot — and guarantees a manifold mesh, which a CAD
  // import needs. Only the newer layer is edited; the older one has already
  // been meshed against.
  const EPS = cell * 1e-3;
  function resolveAmbiguity(prev, cur, r) {
    const fp = prev.f, fc = cur.f;
    const flip = (o) => { fc[o] = fc[o] < 0 ? EPS : -EPS; };
    const weaker = (a, b) => (Math.abs(fc[a]) <= Math.abs(fc[b]) ? a : b);
    for (let pass = 0; pass < 8; pass++) {
      let changed = 0;
      for (let j = r[2]; j <= r[3]; j++) {
        for (let i = r[0]; i <= r[1]; i++) {
          const o = i + nx * j;
          const p0 = fp[o] < 0, p1 = fp[o + 1] < 0, p2 = fp[o + nx] < 0, p3 = fp[o + nx + 1] < 0;
          const c0 = fc[o] < 0, c1 = fc[o + 1] < 0, c2 = fc[o + nx] < 0, c3 = fc[o + nx + 1] < 0;
          const inside = p0 + p1 + p2 + p3 + c0 + c1 + c2 + c3;
          if (inside < 2 || inside > 6) continue;
          // face in the new layer
          if (c0 === c3 && c1 === c2 && c0 !== c1) {
            let m = o;
            for (const q of [o + 1, o + nx, o + nx + 1]) m = weaker(m, q);
            flip(m); changed++;
            continue;
          }
          // the four faces spanning the two layers
          if (p0 === c1 && p1 === c0 && p0 !== p1) { flip(weaker(o, o + 1)); changed++; continue; }
          if (p2 === c3 && p3 === c2 && p2 !== p3) { flip(weaker(o + nx, o + nx + 1)); changed++; continue; }
          if (p0 === c2 && p2 === c0 && p0 !== p2) { flip(weaker(o, o + nx)); changed++; continue; }
          if (p1 === c3 && p3 === c1 && p1 !== p3) { flip(weaker(o + 1, o + nx + 1)); changed++; continue; }
          // two like corners on a body diagonal, alone among six unlike ones
          if (inside === 2 || inside === 6) {
            const s = inside === 2;
            if (p0 === s && c3 === s) { flip(o + nx + 1); changed++; }
            else if (p1 === s && c2 === s) { flip(o + nx); changed++; }
            else if (p2 === s && c1 === s) { flip(o + 1); changed++; }
            else if (p3 === s && c0 === s) { flip(o); changed++; }
          }
        }
      }
      if (!changed) break;
    }
  }

  // ── Naive surface nets, two layers of samples at a time ────────────────
  let pos = new Float32Array(3 * 65536), nv = 0;
  let idx = new Uint32Array(3 * 131072), ni = 0;
  const pushVertex = (x, y, z) => {
    if (nv * 3 + 3 > pos.length) { const n = new Float32Array(pos.length * 2); n.set(pos); pos = n; }
    pos[nv * 3] = x; pos[nv * 3 + 1] = y; pos[nv * 3 + 2] = z;
    return nv++;
  };
  const pushQuad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (ni + 6 > idx.length) { const n = new Uint32Array(idx.length * 2); n.set(idx); idx = n; }
    if (flip) { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
    else { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
  };

  let prev = makeLayer(), cur = makeLayer();
  evalLayer(0, prev);
  for (let kz = 0; kz < nz - 1; kz++) {
    evalLayer(kz + 1, cur);
    fillRect(cur.v, cur.vr, -1);
    cur.vr = null;
    const a = prev.r, b = cur.r;
    if (a || b) {
      // Cells of this slab that can hold surface, with a one-cell margin so
      // quads reaching back to the previous row and column are emitted.
      const r = [
        Math.max(0, Math.min(a ? a[0] : nx, b ? b[0] : nx) - 1),
        Math.min(nx - 2, Math.max(a ? a[1] : -1, b ? b[1] : -1)),
        Math.max(0, Math.min(a ? a[2] : ny, b ? b[2] : ny) - 1),
        Math.min(ny - 2, Math.max(a ? a[3] : -1, b ? b[3] : -1)),
      ];
      cur.vr = r;
      if (kz > 0) {
        resolveAmbiguity(prev, cur, r);
        // Corners it touched must be reset with the rest of the layer.
        cur.r = b
          ? [Math.min(b[0], r[0]), Math.max(b[1], r[1] + 1), Math.min(b[2], r[2]), Math.max(b[3], r[3] + 1)]
          : [r[0], r[1] + 1, r[2], r[3] + 1];
      }
      const fPrev = prev.f, fCur = cur.f, vPrev = prev.v, vCur = cur.v;
      const z0 = min[2] + kz * cell;
      for (let j = r[2]; j <= r[3]; j++) {
        for (let i = r[0]; i <= r[1]; i++) {
          const o = i + nx * j;
          const c0 = fPrev[o], c1 = fPrev[o + 1], c2 = fPrev[o + nx], c3 = fPrev[o + nx + 1];
          const c4 = fCur[o], c5 = fCur[o + 1], c6 = fCur[o + nx], c7 = fCur[o + nx + 1];
          const inside = (c0 < 0) + (c1 < 0) + (c2 < 0) + (c3 < 0) + (c4 < 0) + (c5 < 0) + (c6 < 0) + (c7 < 0);
          if (inside === 0 || inside === 8) continue;
          // Average the crossings on the 12 cell edges.
          let sx = 0, sy = 0, sz = 0, n = 0;
          const edge = (p, q, ax, ay, az, bx, by, bz) => {
            if ((p < 0) === (q < 0)) return;
            const t = p / (p - q);
            sx += ax + (bx - ax) * t; sy += ay + (by - ay) * t; sz += az + (bz - az) * t; n++;
          };
          edge(c0, c1, 0, 0, 0, 1, 0, 0); edge(c2, c3, 0, 1, 0, 1, 1, 0);
          edge(c4, c5, 0, 0, 1, 1, 0, 1); edge(c6, c7, 0, 1, 1, 1, 1, 1);
          edge(c0, c2, 0, 0, 0, 0, 1, 0); edge(c1, c3, 1, 0, 0, 1, 1, 0);
          edge(c4, c6, 0, 0, 1, 0, 1, 1); edge(c5, c7, 1, 0, 1, 1, 1, 1);
          edge(c0, c4, 0, 0, 0, 0, 0, 1); edge(c1, c5, 1, 0, 0, 1, 0, 1);
          edge(c2, c6, 0, 1, 0, 0, 1, 1); edge(c3, c7, 1, 1, 0, 1, 1, 1);
          vCur[o] = pushVertex(
            min[0] + (i + sx / n) * cell,
            min[1] + (j + sy / n) * cell,
            z0 + (sz / n) * cell,
          );
        }
      }
      // One quad per grid edge that crosses the surface, joining the four
      // cells around it. Each cell owns the three edges leaving its minimum
      // corner.
      for (let j = r[2]; j <= r[3]; j++) {
        for (let i = r[0]; i <= r[1]; i++) {
          const o = i + nx * j;
          const s0 = fPrev[o] < 0;
          if (j > 0 && kz > 0 && s0 !== (fPrev[o + 1] < 0)) {
            pushQuad(vCur[o], vCur[o - nx], vPrev[o - nx], vPrev[o], !s0);
          }
          if (i > 0 && kz > 0 && s0 !== (fPrev[o + nx] < 0)) {
            pushQuad(vCur[o], vPrev[o], vPrev[o - 1], vCur[o - 1], !s0);
          }
          if (i > 0 && j > 0 && s0 !== (fCur[o] < 0)) {
            pushQuad(vCur[o], vCur[o - 1], vCur[o - 1 - nx], vCur[o - nx], !s0);
          }
        }
      }
    }
    [prev, cur] = [cur, prev];
  }

  const kept = keepBodies(pos, nv, idx, ni);
  const positions = kept.positions;
  const indices = kept.indices;
  nv = positions.length / 3;
  ni = indices.length;

  // Area-weighted vertex normals.
  const normals = new Float32Array(nv * 3);
  for (let t = 0; t < ni; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nxn = uy * vz - uz * vy, nyn = uz * vx - ux * vz, nzn = ux * vy - uy * vx;
    for (const q of [a, b, c]) { normals[q] += nxn; normals[q + 1] += nyn; normals[q + 2] += nzn; }
  }
  for (let v = 0; v < nv * 3; v += 3) {
    const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
  }

  return { positions, normals, indices, cell, pieces: kept.pieces, skippedHoles };
}

/** Enclosed volume of a closed, consistently wound mesh (divergence theorem). */
export function meshVolume(positions, indices) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
       - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
       + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}
