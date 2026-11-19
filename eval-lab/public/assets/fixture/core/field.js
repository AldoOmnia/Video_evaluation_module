/**
 * Obstacle distance field built from scan points.
 *
 * The generator has to route struts around whatever the scan shows — the part,
 * the table, the station frame — and a point cloud has no surfaces to test
 * against. So the points are binned into voxels and turned into an exact
 * Euclidean distance field once; after that "how far is this point from the
 * scan" is a trilinear lookup, cheap enough to call thousands of times per
 * slider movement.
 */

const FAR = 1e9;

/** Felzenszwalb & Huttenlocher 1D squared distance transform, in place. */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) {
      // Only reachable at k === 0 when both parabolas are at infinity.
      v[0] = q;
    } else {
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = FAR;
    }
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/**
 * @param {Float32Array} points  xyz triples, metres
 * @param {{min:number[], max:number[]}} bounds  region to cover
 * @param {object} [opts]
 * @param {number} [opts.cell=0.02]      voxel edge, metres
 * @param {number} [opts.minPoints=2]    points a voxel needs to count as solid;
 *                                       LiDAR scans carry stray single returns
 * @param {number} [opts.maxCells=4e6]   coarsen the grid rather than exceed this
 */
export function buildDistanceField(points, bounds, opts = {}) {
  const minPoints = opts.minPoints ?? 2;
  const maxCells = opts.maxCells ?? 4e6;
  let cell = opts.cell ?? 0.02;
  const size = [0, 1, 2].map((a) => Math.max(bounds.max[a] - bounds.min[a], cell));
  let dims;
  for (;;) {
    dims = size.map((s) => Math.ceil(s / cell) + 1);
    if (dims[0] * dims[1] * dims[2] <= maxCells) break;
    cell *= 1.25;
  }
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const min = bounds.min.slice();

  const counts = new Uint8Array(total);
  let solid = 0;
  for (let i = 0; i < points.length; i += 3) {
    const ix = Math.floor((points[i] - min[0]) / cell);
    const iy = Math.floor((points[i + 1] - min[1]) / cell);
    const iz = Math.floor((points[i + 2] - min[2]) / cell);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
    const k = ix + nx * (iy + ny * iz);
    if (counts[k] < 255) counts[k]++;
  }

  const d2 = new Float32Array(total);
  for (let k = 0; k < total; k++) {
    if (counts[k] >= minPoints) {
      d2[k] = 0;
      solid++;
    } else d2[k] = FAR;
  }

  if (solid > 0) {
    const m = Math.max(nx, ny, nz);
    const f = new Float64Array(m), d = new Float64Array(m);
    const v = new Int32Array(m), z = new Float64Array(m + 1);
    // x
    for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) {
      const o = nx * (iy + ny * iz);
      for (let i = 0; i < nx; i++) f[i] = d2[o + i];
      edt1d(f, nx, d, v, z);
      for (let i = 0; i < nx; i++) d2[o + i] = d[i];
    }
    // y
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const o = ix + nx * ny * iz;
      for (let i = 0; i < ny; i++) f[i] = d2[o + nx * i];
      edt1d(f, ny, d, v, z);
      for (let i = 0; i < ny; i++) d2[o + nx * i] = d[i];
    }
    // z
    const sxy = nx * ny;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const o = ix + nx * iy;
      for (let i = 0; i < nz; i++) f[i] = d2[o + sxy * i];
      edt1d(f, nz, d, v, z);
      for (let i = 0; i < nz; i++) d2[o + sxy * i] = d[i];
    }
  }

  // Store metres. Distances are to voxel centres, so a point touching a
  // surface reads about half a cell; callers treat `cell` as the noise floor.
  const distM = d2;
  const farM = Math.hypot(size[0], size[1], size[2]);
  for (let k = 0; k < total; k++) distM[k] = solid > 0 ? Math.min(Math.sqrt(d2[k]) * cell, farM) : farM;

  const at = (ix, iy, iz) => distM[ix + nx * (iy + ny * iz)];

  /** Distance from `p` to the nearest scanned surface, metres. */
  function sample(p) {
    let fx = (p[0] - min[0]) / cell - 0.5;
    let fy = (p[1] - min[1]) / cell - 0.5;
    let fz = (p[2] - min[2]) / cell - 0.5;
    // Outside the grid nothing was scanned into the field: clamp to the edge
    // value so the gradient stays finite instead of reporting a false wall.
    fx = fx < 0 ? 0 : fx > nx - 1.001 ? nx - 1.001 : fx;
    fy = fy < 0 ? 0 : fy > ny - 1.001 ? ny - 1.001 : fy;
    fz = fz < 0 ? 0 : fz > nz - 1.001 ? nz - 1.001 : fz;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const ix1 = Math.min(ix + 1, nx - 1), iy1 = Math.min(iy + 1, ny - 1), iz1 = Math.min(iz + 1, nz - 1);
    const c00 = at(ix, iy, iz) * (1 - tx) + at(ix1, iy, iz) * tx;
    const c10 = at(ix, iy1, iz) * (1 - tx) + at(ix1, iy1, iz) * tx;
    const c01 = at(ix, iy, iz1) * (1 - tx) + at(ix1, iy, iz1) * tx;
    const c11 = at(ix, iy1, iz1) * (1 - tx) + at(ix1, iy1, iz1) * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  }

  /** Unit direction of steepest increase in clearance at `p`. */
  function gradient(p) {
    const h = cell;
    const g = [
      sample([p[0] + h, p[1], p[2]]) - sample([p[0] - h, p[1], p[2]]),
      sample([p[0], p[1] + h, p[2]]) - sample([p[0], p[1] - h, p[2]]),
      sample([p[0], p[1], p[2] + h]) - sample([p[0], p[1], p[2] - h]),
    ];
    const l = Math.hypot(g[0], g[1], g[2]);
    return l > 1e-9 ? [g[0] / l, g[1] / l, g[2] / l] : [0, 0, 0];
  }

  return { min, cell, dims, solid, sample, gradient };
}
