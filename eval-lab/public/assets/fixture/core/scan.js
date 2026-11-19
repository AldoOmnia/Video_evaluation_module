/**
 * Working with the scan: orientation, finding the temporary arm, fitting the
 * surfaces the new support will bolt to.
 *
 * Everything here is plain geometry on the point cloud. None of it decides
 * anything on its own — it proposes (this cluster looks like the arm, this
 * patch is a flat surface facing that way) and the page shows the proposal for
 * the engineer to accept or correct.
 */
import * as V from "./vec.js";

/**
 * Which axis is vertical. Phone scanners export Y-up, CAD tools Z-up. The
 * floor shows up as the tallest spike in a height histogram, so the axis with
 * the sharper spike is up.
 */
export function detectUpAxis(positions) {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / 200000));
  const peak = (axis) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i += step) { const v = positions[i * 3 + axis]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const bin = 0.05;
    const hist = new Uint32Array(Math.max(1, Math.ceil((hi - lo) / bin) + 1));
    let total = 0;
    for (let i = 0; i < n; i += step) { hist[Math.floor((positions[i * 3 + axis] - lo) / bin)]++; total++; }
    let best = 0;
    for (const h of hist) if (h > best) best = h;
    return best / total;
  };
  const py = peak(1), pz = peak(2);
  return { axis: py > pz ? "y" : "z", confidence: Math.max(py, pz) / Math.max(1e-9, Math.min(py, pz)) };
}

/** Rotate a Y-up cloud to Z-up in place: (x, y, z) → (x, −z, y). */
export function yUpToZUp(positions) {
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    positions[i + 1] = -positions[i + 2];
    positions[i + 2] = y;
  }
  return positions;
}

/** Turn a cloud upside down in place: half a turn about X, (x, y, z) → (x, −y, −z). */
export function flipUp(positions) {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = -positions[i + 1];
    positions[i + 2] = -positions[i + 2];
  }
  return positions;
}

export function boundsOf(positions, mask) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0, k = 0; i < positions.length; i += 3, k++) {
    if (mask && mask[k]) continue;
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/** Height of the lowest large horizontal surface — the floor. */
export function floorHeight(positions) {
  const n = positions.length / 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = positions[i * 3 + 2]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const bin = 0.02;
  const hist = new Uint32Array(Math.ceil((hi - lo) / bin) + 1);
  for (let i = 0; i < n; i++) hist[Math.floor((positions[i * 3 + 2] - lo) / bin)]++;
  let best = 0;
  for (const h of hist) if (h > best) best = h;
  for (let b = 0; b < hist.length; b++) if (hist[b] > best * 0.35) return lo + (b + 0.5) * bin;
  return lo;
}

/**
 * Propose which points belong to the temporary arm holding the camera.
 *
 * Flood-fills outward from the camera through connected scan material, and
 * refuses to cross broad horizontal surfaces — the floor and the bench top are
 * where a stand rests, not part of it. Limited to `reach` from the camera so a
 * stand that touches a wall or the part does not take the whole station with
 * it.
 *
 * @returns {{mask: Uint8Array, count: number, voxels: number}} mask[i] = 1 for arm points
 */
export function findArm(positions, opts) {
  const seed = opts.seed;
  const reach = opts.reach ?? 1.5;
  const cell = opts.cell ?? 0.02;
  const seedRadius = opts.seedRadius ?? 0.09;
  const n = positions.length / 3;
  const mask = new Uint8Array(n);

  const min = seed.map((s) => s - reach - cell * 2);
  const dims = [0, 1, 2].map(() => Math.ceil((2 * reach + cell * 4) / cell));
  const [nx, ny, nz] = dims;
  const sxy = nx * ny;
  const total = sxy * nz;
  if (total > 40e6) throw new Error("reach is too large for the voxel size");

  const counts = new Uint8Array(total);
  const voxelOf = (i) => {
    const x = Math.floor((positions[i * 3] - min[0]) / cell);
    const y = Math.floor((positions[i * 3 + 1] - min[1]) / cell);
    const z = Math.floor((positions[i * 3 + 2] - min[2]) / cell);
    return x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? -1 : x + nx * y + sxy * z;
  };
  for (let i = 0; i < n; i++) {
    const k = voxelOf(i);
    if (k >= 0 && counts[k] < 255) counts[k]++;
  }
  const minPoints = opts.minPoints ?? 2;

  // A voxel is on a support surface when most of the columns around it are
  // occupied at its own height. A mast or arm fills a few columns; a floor or
  // bench top fills nearly all of them.
  const W = 3;
  const need = Math.ceil((2 * W + 1) ** 2 * (opts.planarFraction ?? 0.6));
  // 0 empty · 1 free-standing · 2 support surface · 3 arm · 4 free-standing but sparse
  const state = new Uint8Array(total);
  const colOcc = (x, y, z) => {
    const k = x + nx * y + sxy * z;
    return counts[k] >= minPoints || (z > 0 && counts[k - sxy] >= minPoints) || (z < nz - 1 && counts[k + sxy] >= minPoints);
  };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const k = x + nx * y + sxy * z;
    if (counts[k] === 0) continue;
    let occ = 0;
    if (x >= W && y >= W && x < nx - W && y < ny - W) {
      for (let dy = -W; dy <= W; dy++) for (let dx = -W; dx <= W; dx++) if (colOcc(x + dx, y + dy, z)) occ++;
    }
    state[k] = occ >= need ? 2 : counts[k] >= minPoints ? 1 : 4;
  }

  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  const sx = Math.floor((seed[0] - min[0]) / cell), sy = Math.floor((seed[1] - min[1]) / cell), sz = Math.floor((seed[2] - min[2]) / cell);
  for (const radius of [seedRadius, seedRadius * 2.5]) {
    const R = Math.ceil(radius / cell);
    for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy + dz * dz > R * R) continue;
      const x = sx + dx, y = sy + dy, z = sz + dz;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      const k = x + nx * y + sxy * z;
      if (state[k] === 1) { state[k] = 3; queue[tail++] = k; }
    }
    if (tail > 0) break;
  }

  const R2 = (reach / cell) ** 2;
  let voxels = tail;
  while (head < tail) {
    const k = queue[head++];
    const z = Math.floor(k / sxy), y = Math.floor((k - z * sxy) / nx), x = k - z * sxy - y * nx;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const q = X + nx * Y + sxy * Z;
      if (state[q] !== 1) continue;
      if ((X - sx) ** 2 + (Y - sy) ** 2 + (Z - sz) ** 2 > R2) continue;
      state[q] = 3;
      queue[tail++] = q;
      voxels++;
    }
  }

  // The flood ran through well-populated voxels so that stray returns could
  // not bridge a gap. Now pick up the thinly sampled voxels touching the arm,
  // or a fringe of its points would be left hanging in the air as obstacles.
  for (let q = 0; q < tail; q++) {
    const k = queue[q];
    const z = Math.floor(k / sxy), y = Math.floor((k - z * sxy) / nx), x = k - z * sxy - y * nx;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const q2 = X + nx * Y + sxy * Z;
      if (state[q2] === 4) state[q2] = 5;
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) {
    const k = voxelOf(i);
    if (k >= 0 && (state[k] === 3 || state[k] === 5)) { mask[i] = 1; count++; }
  }
  return { mask, count, voxels };
}

/** Mark (value 1) or restore (value 0) every point within `radius` of `center`. */
export function brush(positions, mask, center, radius, value) {
  const r2 = radius * radius;
  let changed = 0;
  for (let i = 0, k = 0; i < positions.length; i += 3, k++) {
    const dx = positions[i] - center[0], dy = positions[i + 1] - center[1], dz = positions[i + 2] - center[2];
    if (dx * dx + dy * dy + dz * dz <= r2 && mask[k] !== value) { mask[k] = value; changed++; }
  }
  return changed;
}

/** Eigen-decomposition of a symmetric 3×3 matrix by Jacobi rotations. */
function eigenSym3(m) {
  const a = [m[0].slice(), m[1].slice(), m[2].slice()];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

/**
 * Fit a plane to the scan around a picked point — the surface a foot bolts to.
 *
 * @param {number[]} toward  a point the normal should face (the camera)
 * @returns {{p, n, rms, count, flat}} `flat` is false when the patch is not a
 *          usable mounting surface (too few points, or too rough)
 */
export function fitPlane(positions, center, radius, mask, toward) {
  const r2 = radius * radius;
  const near = [];
  for (let i = 0, k = 0; i < positions.length; i += 3, k++) {
    if (mask && mask[k]) continue;
    const dx = positions[i] - center[0], dy = positions[i + 1] - center[1], dz = positions[i + 2] - center[2];
    if (dx * dx + dy * dy + dz * dz <= r2) near.push(i);
  }
  if (near.length < 12) return { p: center.slice(), n: [0, 0, 1], rms: Infinity, count: near.length, flat: false };

  // The patch around a pick usually holds more than one surface — the edge of
  // a bench, a bracket standing on it. Fit everything first for a direction,
  // then refit using only the points close to the plane through the pick.
  const TOL = 0.015;
  let nrm = null, offset = 0, rms = Infinity, count = 0;
  for (let pass = 0; pass < 4; pass++) {
    let cx = 0, cy = 0, cz = 0;
    const use = [];
    for (const i of near) {
      if (nrm) {
        const h = (positions[i] - center[0]) * nrm[0] + (positions[i + 1] - center[1]) * nrm[1] + (positions[i + 2] - center[2]) * nrm[2];
        if (Math.abs(h - offset) > TOL) continue;
      }
      use.push(i);
      cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2];
    }
    if (use.length < 12) break;
    count = use.length;
    cx /= count; cy /= count; cz /= count;
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of use) {
      const d = [positions[i] - cx, positions[i + 1] - cy, positions[i + 2] - cz];
      for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) m[a][b] += d[a] * d[b];
    }
    m[1][0] = m[0][1]; m[2][0] = m[0][2]; m[2][1] = m[1][2];
    const { values, vectors } = eigenSym3(m);
    let s = 0;
    if (values[1] < values[s]) s = 1;
    if (values[2] < values[s]) s = 2;
    nrm = V.norm([vectors[0][s], vectors[1][s], vectors[2][s]]);
    rms = Math.sqrt(Math.max(values[s], 0) / count);
    // After the first pass the plane is pinned near the pick; later passes
    // let it settle onto the inliers' mean height.
    offset = pass === 0 ? 0 : (cx - center[0]) * nrm[0] + (cy - center[1]) * nrm[1] + (cz - center[2]) * nrm[2];
  }
  if (!nrm) return { p: center.slice(), n: [0, 0, 1], rms: Infinity, count: 0, flat: false };
  const p = V.addScaled(center, nrm, offset);
  const ref = toward ? V.sub(toward, p) : [0, 0, 1];
  if (V.dot(nrm, ref) < 0) nrm = V.scale(nrm, -1);
  return { p, n: nrm, rms, count, flat: rms < 0.01 && count >= 30 };
}

/** Repeatable random numbers: the same click must give the same ring. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Circle through three 2D points, or null if they are nearly in line. */
function circle3(ax, ay, bx, by, cx, cy) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, r: Math.hypot(ax - x, ay - y) };
}

/** Least-squares circle through 2D points (Kåsa). */
function circleFit(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] · [A B C]ᵀ = [sxz syz sz]ᵀ, centre = (A/2, B/2).
  const m = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-14) return null;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  const A = m[0][3] / m[0][0], B = m[1][3] / m[1][1], C = m[2][3] / m[2][2];
  return { x: A / 2, y: B / 2, r: Math.sqrt(Math.max(C + (A * A + B * B) / 4, 0)) };
}

const median = (list) => {
  const s = list.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/**
 * The plane through a picked point that the most scan material lies in.
 *
 * `fitPlane` averages the patch round the pick, which is right for a broad
 * surface. On a narrow face — the rim of a flange — most of the patch is the
 * wall below the rim, and the average tilts. Here every direction is tried
 * and the ones whose planes collect the most points are returned, best first,
 * so a narrow face still shows up beside the clutter next to it.
 */
function dominantPlanes(positions, pick, radius, mask, toward, keep = 3) {
  const near = [];
  const r2 = radius * radius;
  for (let i = 0, k = 0; i < positions.length; i += 3, k++) {
    if (mask && mask[k]) continue;
    const dx = positions[i] - pick[0], dy = positions[i + 1] - pick[1], dz = positions[i + 2] - pick[2];
    if (dx * dx + dy * dy + dz * dz <= r2) near.push(dx, dy, dz);
  }
  const count = near.length / 3;
  if (count < 60) return [];
  const TOL = 0.004;
  // A click lands on the nearest point under the cursor, which can be a stray
  // return a few millimetres off the face, so the plane's height is voted on
  // too: slices 2 mm thick, up to 14 mm either side of the pick.
  const BIN = 0.002, BINS = 15, MID = 7;
  const votes = [];
  const hist = new Uint32Array(BINS);
  // Directions spread evenly over a hemisphere (a Fibonacci spiral).
  const DIRS = 400;
  for (let d = 0; d < DIRS; d++) {
    const z = (d + 0.5) / DIRS, rho = Math.sqrt(1 - z * z), phi = d * 2.399963229728653;
    const nx = rho * Math.cos(phi), ny = rho * Math.sin(phi), nz = z;
    hist.fill(0);
    for (let i = 0; i < near.length; i += 3) {
      const b = Math.round((near[i] * nx + near[i + 1] * ny + near[i + 2] * nz) / BIN) + MID;
      if (b >= 0 && b < BINS) hist[b]++;
    }
    let top = null;
    for (let b = 1; b < BINS - 2; b++) {
      const hits = hist[b - 1] + hist[b] + hist[b + 1] + hist[b + 2];
      if (!top || hits > top.hits) top = { n: [nx, ny, nz], hits, offset: (b + 0.5 - MID) * BIN };
    }
    votes.push(top);
  }
  // The strongest few that are different surfaces, not one surface twice.
  votes.sort((a, b) => b.hits - a.hits);
  const chosen = [];
  for (const c of votes) {
    if (chosen.length >= keep || c.hits < votes[0].hits * 0.4) break;
    if (chosen.every((o) => Math.abs(V.dot(o.n, c.n)) < 0.99)) chosen.push(c);
  }
  return chosen.map((c) => settlePlane(near, pick, c, TOL, toward)).filter(Boolean);
}

/** Least-squares plane through the points a voted plane collected. */
function settlePlane(near, pick, vote, TOL, toward) {
  let n = vote.n, offset = vote.offset, rms = Infinity, used = 0;
  for (let pass = 0; pass < 3; pass++) {
    let cx = 0, cy = 0, cz = 0;
    const use = [];
    for (let i = 0; i < near.length; i += 3) {
      if (Math.abs(near[i] * n[0] + near[i + 1] * n[1] + near[i + 2] * n[2] - offset) > TOL * 1.5) continue;
      use.push(i);
      cx += near[i]; cy += near[i + 1]; cz += near[i + 2];
    }
    if (use.length < 30) break;
    used = use.length;
    cx /= used; cy /= used; cz /= used;
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of use) {
      const q = [near[i] - cx, near[i + 1] - cy, near[i + 2] - cz];
      for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) m[a][b] += q[a] * q[b];
    }
    m[1][0] = m[0][1]; m[2][0] = m[0][2]; m[2][1] = m[1][2];
    const { values, vectors } = eigenSym3(m);
    let k = 0;
    if (values[1] < values[k]) k = 1;
    if (values[2] < values[k]) k = 2;
    let n2 = V.norm([vectors[0][k], vectors[1][k], vectors[2][k]]);
    if (V.dot(n2, n) < 0) n2 = V.scale(n2, -1);
    if (V.dot(n2, n) < 0.94) break; // the inliers are not one surface; keep the voted plane
    n = n2;
    offset = cx * n[0] + cy * n[1] + cz * n[2];
    rms = Math.sqrt(Math.max(values[k], 0) / used);
  }
  if (!used || rms > 0.006) return null;
  const p = V.addScaled(pick, n, offset);
  if (V.dot(n, toward ? V.sub(toward, p) : [0, 0, 1]) < 0) n = V.scale(n, -1);
  return { p, n, rms, count: used };
}

/**
 * Fit the flat round face around a picked point — a flange, a bore's rim, a
 * round table — so a ring can sit on it.
 *
 * The face is the scan material lying in the plane of the pick and connected
 * to it. Its outline is searched for the circle that goes furthest round — an
 * edge of the face — and from that circle's centre the face is measured in
 * every direction: where it starts, where it stops.
 *
 * @param {number[]} toward  a point the face's normal should point to (the camera)
 * @returns {{ok: boolean, reason?: string, c, n, rIn, rOut, rms, coverage, count}}
 *          `rIn` is 0 for a face with no hole; `coverage` is the fraction of
 *          the way round that the scan shows the face.
 */
export function fitRing(positions, pick, mask, toward, opts = {}) {
  const planes = dominantPlanes(positions, pick, opts.patch ?? 0.12, mask, toward);
  if (!planes.length) return { ok: false, reason: "the scan does not show a flat surface at that point" };
  // The patch at the pick can hold more than one flat surface — the face and
  // whatever stands next to it. The face wanted is the one that is round.
  let best = null;
  for (const plane of planes) {
    const r = ringInPlane(positions, pick, mask, plane, opts);
    if (!best || (r.ok && (!best.ok || r.round > best.round + 0.05))) best = r;
  }
  return best;
}

function ringInPlane(positions, pick, mask, plane, opts) {
  const fail = (reason) => ({ ok: false, reason });
  const SLAB = 0.008, CELL = 0.006, REACH = opts.reach ?? 0.6, MAX_R = 0.45, SECTORS = 72;
  const n = plane.n, origin = plane.p;
  const [u, v] = V.basis(n);

  // Scan material in the plane of the pick, as a grid of cells.
  const half = Math.ceil(REACH / CELL), N = 2 * half + 1;
  const counts = new Uint16Array(N * N);
  const inSlab = [];
  for (let i = 0, k = 0; i < positions.length; i += 3, k++) {
    if (mask && mask[k]) continue;
    const dx = positions[i] - origin[0], dy = positions[i + 1] - origin[1], dz = positions[i + 2] - origin[2];
    if (Math.abs(dx * n[0] + dy * n[1] + dz * n[2]) > SLAB) continue;
    const a = dx * u[0] + dy * u[1] + dz * u[2], b = dx * v[0] + dy * v[1] + dz * v[2];
    if (a * a + b * b > REACH * REACH) continue;
    inSlab.push(i);
    const o = Math.round(a / CELL) + half + N * (Math.round(b / CELL) + half);
    if (counts[o] < 65535) counts[o]++;
  }
  // A surface fills its cells; stray returns above an edge leave one or two
  // points in theirs. The bar is set from how densely this scan covers the face.
  const pi = Math.round(V.dot(V.sub(pick, origin), u) / CELL) + half, pj = Math.round(V.dot(V.sub(pick, origin), v) / CELL) + half;
  const density = [];
  for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
    const i = pi + di, j = pj + dj;
    if (i >= 0 && j >= 0 && i < N && j < N && counts[i + N * j] > 0) density.push(counts[i + N * j]);
  }
  if (density.length < 8) return fail("too few scan points at that spot to follow the face");
  const need = Math.max(2, Math.round(median(density) * 0.3));
  const filled = (o) => counts[o] >= need;

  // The part of it connected to the pick.
  let seed = -1, seedD = Infinity;
  for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
    const i = pi + di, j = pj + dj;
    if (i < 0 || j < 0 || i >= N || j >= N || !filled(i + N * j)) continue;
    const d = di * di + dj * dj;
    if (d < seedD) { seedD = d; seed = i + N * j; }
  }
  if (seed < 0) return fail("too few scan points at that spot to follow the face");
  const comp = new Uint8Array(N * N);
  const queue = [seed];
  comp[seed] = 1;
  for (let q = 0; q < queue.length; q++) {
    const o = queue[q], i = o % N, j = (o - i) / N;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const I = i + di, J = j + dj;
      if (I < 1 || J < 1 || I >= N - 1 || J >= N - 1) continue;
      const p = I + N * J;
      if (comp[p] || !filled(p)) continue;
      comp[p] = 1;
      queue.push(p);
    }
  }
  if (queue.length < 60) return fail("too little flat scan surface around that point to carry a ring");
  const xy = (o) => { const i = o % N; return [(i - half) * CELL, ((o - i) / N - half) * CELL]; };
  const outline = queue.filter((o) => !comp[o - 1] || !comp[o + 1] || !comp[o - N] || !comp[o + N]).map(xy);
  const [px, py] = xy(seed);

  // The circle that follows the outline furthest round. Scored by how many
  // directions from its centre find outline on it, so a long straight edge or
  // a neighbouring part cannot outvote a true circle.
  const rand = mulberry32(outline.length * 2654435761 + queue.length);
  // How far round a circle the outline follows it, as a fraction. Directions
  // are counted only as finely as cells are apart on the circle; otherwise any
  // small clump of outline would look like a full turn.
  const roundness = (c) => {
    const sectors = Math.max(16, Math.min(SECTORS, Math.floor((2 * Math.PI * c.r) / (1.5 * CELL))));
    const seen = new Uint8Array(sectors);
    let hit = 0;
    for (const [x, y] of outline) {
      const dx = x - c.x, dy = y - c.y;
      if (Math.abs(Math.hypot(dx, dy) - c.r) > CELL) continue;
      const k = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * sectors) % sectors;
      if (!seen[k]) { seen[k] = 1; hit++; }
    }
    return hit / sectors;
  };
  // An edge of the face under the click passes close to the click, so one of
  // the three points each trial circle is drawn through is taken from there.
  const byPick = outline.map(([x, y]) => Math.hypot(x - px, y - py));
  const nearest = Math.min(...byPick);
  const local = outline.filter((_, i) => byPick[i] <= nearest + 0.03);
  let best = null;
  for (let t = 0; t < 4000; t++) {
    const a = local[Math.floor(rand() * local.length)], b = outline[Math.floor(rand() * outline.length)], d = outline[Math.floor(rand() * outline.length)];
    const c = circle3(a[0], a[1], b[0], b[1], d[0], d[1]);
    if (!c || c.r < 0.025 || c.r > MAX_R) continue;
    const round = roundness(c);
    if (round < 0.35) continue;
    // The most complete circle; of two equally complete, the larger.
    const score = round + c.r * 0.05;
    if (!best || score > best.score) best = { ...c, score, round };
  }
  if (!best) return fail("no round outline found in the flat area there — click on the round face itself");
  for (let pass = 0; pass < 3; pass++) {
    const on = outline.filter(([x, y]) => Math.abs(Math.hypot(x - best.x, y - best.y) - best.r) < CELL * 1.5);
    const fit = on.length >= 12 ? circleFit(on) : null;
    if (!fit) break;
    best = { ...fit, score: best.score, round: roundness(fit) };
  }

  // The face in every direction from that centre: where it starts and stops.
  const at = (x, y) => {
    const i = Math.round(x / CELL) + half, j = Math.round(y / CELL) + half;
    return i >= 0 && j >= 0 && i < N && j < N && comp[i + N * j] === 1;
  };
  // The fitted circle is one edge of the face; the pick says which side the face is on.
  const side = Math.hypot(px - best.x, py - best.y) >= best.r ? 1 : -1;
  let start = best.r + side * CELL * 1.5;
  let edges = [], agree = [], rOutM = 0, rInM = 0;
  for (let pass = 0; pass < 3; pass++) {
    edges = [];
    for (let k = 0; k < SECTORS; k++) {
      const th = (2 * Math.PI * (k + 0.5)) / SECTORS, cx = Math.cos(th), cy = Math.sin(th);
      let hit = -1;
      for (const off of [0, 1, -1, 2, -2]) {
        const r = start + off * CELL;
        if (r > 0 && at(best.x + cx * r, best.y + cy * r)) { hit = r; break; }
      }
      if (hit < 0) continue;
      const walk = (dir) => {
        let r = hit, gap = 0;
        for (let q = hit + dir * CELL * 0.5; q > 0 && q < MAX_R + 0.1; q += dir * CELL * 0.5) {
          if (at(best.x + cx * q, best.y + cy * q)) { r = q; gap = 0; } else if (++gap > 2) break;
        }
        return r;
      };
      edges.push({ k, cx, cy, rIn: walk(-1), rOut: walk(1) });
    }
    if (edges.length < SECTORS * 0.3) return fail("the scan shows too little of that round face to place a ring on it");
    // Where a neighbouring part sits at the same height the face seems to run
    // on; most directions agree, and the middle value is the face's own edge.
    rOutM = median(edges.map((e) => e.rOut));
    rInM = median(edges.map((e) => e.rIn));
    agree = edges.filter((e) => Math.abs(e.rOut - rOutM) < 0.015 && Math.abs(e.rIn - rInM) < 0.015);
    if (pass === 2 || agree.length < 16) break;
    // Both edges of the face are circles about the same centre: centre on them.
    const fits = [circleFit(agree.map((e) => [best.x + e.cx * e.rOut, best.y + e.cy * e.rOut]))];
    if (rInM > CELL * 3) fits.push(circleFit(agree.map((e) => [best.x + e.cx * e.rIn, best.y + e.cy * e.rIn])));
    const ok = fits.filter((f) => f && Math.hypot(f.x - best.x, f.y - best.y) < 0.02);
    if (!ok.length) break;
    best = { ...best, x: ok.reduce((t, f) => t + f.x, 0) / ok.length, y: ok.reduce((t, f) => t + f.y, 0) / ok.length };
    start = (rOutM + rInM) / 2;
  }
  let rOut = rOutM, rIn = rInM;
  if (rIn < CELL * 3) rIn = 0; // the walk reached the centre: a disc, not an annulus

  // The cells place the edges to within a cell. The points place them closer:
  // going out from the middle of the face, the edge is where the scan thins
  // to half of what covers the face. Only the directions that agreed are
  // counted, so a part lying against the face does not move its edge.
  {
    const BIN = 0.002, lo = Math.max(rIn - CELL * 2, 0), bins = Math.ceil((rOut + CELL * 2 - lo) / BIN);
    const use = new Uint8Array(SECTORS);
    for (const e of agree) use[e.k] = 1;
    const per = new Float64Array(bins);
    const cxw = origin[0] + u[0] * best.x + v[0] * best.y, cyw = origin[1] + u[1] * best.x + v[1] * best.y, czw = origin[2] + u[2] * best.x + v[2] * best.y;
    for (const i of inSlab) {
      const dx = positions[i] - cxw, dy = positions[i + 1] - cyw, dz = positions[i + 2] - czw;
      const a = dx * u[0] + dy * u[1] + dz * u[2], b = dx * v[0] + dy * v[1] + dz * v[2];
      const r = Math.hypot(a, b), bin = Math.floor((r - lo) / BIN);
      if (bin < 0 || bin >= bins) continue;
      let th = Math.atan2(b, a);
      if (th < 0) th += 2 * Math.PI;
      if (use[Math.min(SECTORS - 1, Math.floor((th / (2 * Math.PI)) * SECTORS))]) per[bin]++;
    }
    // Points per unit of area: a ring of bins further out is longer.
    const dens = Array.from(per, (c, bin) => c / (lo + (bin + 0.5) * BIN));
    const first = Math.ceil((rIn + CELL - lo) / BIN), last = Math.floor((rOut - CELL - lo) / BIN);
    const body = dens.slice(Math.max(first, 0), last + 1);
    const level = median(body);
    if (body.length >= 3 && median(Array.from(per).slice(Math.max(first, 0), last + 1)) >= 12) {
      // Where the density crosses half the face's level, between two bins.
      const cross = (from, dir) => {
        for (let bin = from; bin + dir >= 0 && bin + dir < bins; bin += dir) {
          const here = dens[bin], next = dens[bin + dir];
          if (next >= level / 2) continue;
          const f = here > next ? (here - level / 2) / (here - next) : 0;
          return lo + (bin + 0.5 + dir * Math.min(Math.max(f, 0), 1)) * BIN;
        }
        return null;
      };
      const mid = Math.round((first + last) / 2);
      const out = cross(mid, 1);
      if (out != null && Math.abs(out - rOut) < CELL * 1.5) rOut = out;
      const inn = rIn > 0 ? cross(mid, -1) : null;
      if (inn != null && Math.abs(inn - rIn) < CELL * 1.5) rIn = inn;
    }
  }
  if (rOut < 0.04) return fail("that round face is too small to carry a ring");
  if (rOut - rIn < 0.012) return fail("that round face is too narrow to carry a ring");
  const pickR = Math.hypot(px - best.x, py - best.y);
  if (pickR < rIn - 0.015 || pickR > rOut + 0.015) return fail("the round face found there is not the one under the click — click on the face itself");

  // Flatness of the face itself, and its height at the centre.
  const c0 = V.add(origin, V.add(V.scale(u, best.x), V.scale(v, best.y)));
  let sum = 0, sum2 = 0, count = 0;
  for (const i of inSlab) {
    const dx = positions[i] - c0[0], dy = positions[i + 1] - c0[1], dz = positions[i + 2] - c0[2];
    const r = Math.hypot(dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]);
    if (r < rIn || r > rOut) continue;
    const h = dx * n[0] + dy * n[1] + dz * n[2];
    sum += h; sum2 += h * h; count++;
  }
  const mean = count ? sum / count : 0;
  const rms = count ? Math.sqrt(Math.max(sum2 / count - mean * mean, 0)) : plane.rms;

  return {
    ok: true, c: V.addScaled(c0, n, mean), n, rIn, rOut, rms, coverage: edges.length / SECTORS, count, round: best.round,
  };
}

/**
 * Middle of the blob of scan points around a picked point.
 *
 * A click lands on the blob's surface, so the first centroid is pulled toward
 * the clicked side. Re-centring a few times walks it to the middle.
 */
export function blobCentre(positions, center, radius, iterations = 5) {
  const r2 = radius * radius;
  let c = center.slice();
  for (let it = 0; it < iterations; it++) {
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const dx = positions[i] - c[0], dy = positions[i + 1] - c[1], dz = positions[i + 2] - c[2];
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2];
      count++;
    }
    if (!count) break;
    const next = [cx / count, cy / count, cz / count];
    const moved = V.dist(next, c);
    c = next;
    if (moved < 5e-4) break;
  }
  return c;
}

/** Points that are obstacles for the generator: inside `bounds`, not masked. */
export function obstaclePoints(positions, mask, bounds) {
  const out = [];
  for (let i = 0, k = 0; i < positions.length; i += 3, k++) {
    if (mask && mask[k]) continue;
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < bounds.min[0] || y < bounds.min[1] || z < bounds.min[2] || x > bounds.max[0] || y > bounds.max[1] || z > bounds.max[2]) continue;
    out.push(x, y, z);
  }
  return Float32Array.from(out);
}

/** Box around the camera and anchors, padded — the region the generator works in. */
export function workBounds(cameraCentre, anchors, margin = 0.5) {
  const min = cameraCentre.slice(), max = cameraCentre.slice();
  for (const a of anchors) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], a.p[k]);
    max[k] = Math.max(max[k], a.p[k]);
  }
  return { min: min.map((v) => v - margin), max: max.map((v) => v + margin) };
}
