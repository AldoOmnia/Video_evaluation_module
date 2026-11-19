/**
 * Synthetic station scan.
 *
 * A stand-in for a real LiDAR capture, laid out like the Comer camera-position
 * scans: a floor, a bench carrying a housing, and a temporary stand beside the
 * bench whose arm holds the camera over the part. It exists so the generator
 * can be tested without client data and so the page has something to show
 * before a scan is loaded. It is clearly labelled as a sample in the UI.
 *
 * Deterministic: the same seed always gives the same cloud.
 */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ground-truth layout, metres, Z up. Exported so tests can check against it. */
export const SAMPLE_TRUTH = {
  camera: { center: [0.02, -0.34, 1.32], target: [0.0, 0.0, 0.62] },
  benchTop: 0.47,
  // Good places to bolt a permanent support: the bench top behind the part,
  // and the floor beside the bench.
  anchors: [
    { p: [-0.42, -0.36, 0.47], n: [0, 0, 1] },
    { p: [0.75, -0.75, 0.0], n: [0, 0, 1] },
  ],
  stand: { mast: [0.78, -0.62], top: 1.78 },
};

/**
 * @param {object} [opts] { density: points per m², noise: metres, seed }
 * @returns {{positions: Float32Array, colors: Uint8Array, count: number}}
 */
export function makeSampleScan(opts = {}) {
  const density = opts.density ?? 9000;
  const noise = opts.noise ?? 0.006;
  const rand = rng(opts.seed ?? 7);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.87 * noise;
  const pos = [];
  const col = [];

  const put = (x, y, z, c, shade = 1) => {
    pos.push(x + gauss(), y + gauss(), z + gauss());
    const j = 0.88 + rand() * 0.24;
    col.push(Math.min(255, c[0] * shade * j), Math.min(255, c[1] * shade * j), Math.min(255, c[2] * shade * j));
  };
  /** Sample a parallelogram: origin o, edges a and b. */
  const quad = (o, a, b, c, shade = 1) => {
    const area = Math.hypot(
      a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
    );
    const n = Math.max(1, Math.round(area * density));
    for (let i = 0; i < n; i++) {
      const s = rand(), t = rand();
      put(o[0] + a[0] * s + b[0] * t, o[1] + a[1] * s + b[1] * t, o[2] + a[2] * s + b[2] * t, c, shade);
    }
  };
  /** Outer faces of an axis-aligned box; bottom omitted when it rests on something. */
  const box = (lo, hi, c, bottom = false) => {
    const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    quad([x0, y0, z1], [dx, 0, 0], [0, dy, 0], c, 1.0);
    if (bottom) quad([x0, y0, z0], [dx, 0, 0], [0, dy, 0], c, 0.55);
    quad([x0, y0, z0], [dx, 0, 0], [0, 0, dz], c, 0.8);
    quad([x0, y1, z0], [dx, 0, 0], [0, 0, dz], c, 0.72);
    quad([x0, y0, z0], [0, dy, 0], [0, 0, dz], c, 0.86);
    quad([x1, y0, z0], [0, dy, 0], [0, 0, dz], c, 0.66);
  };
  /** Surface of a cylinder from a to b. */
  const tube = (a, b, r, c) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(...d);
    const ax = d.map((x) => x / L);
    const ref = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = [ref[1] * ax[2] - ref[2] * ax[1], ref[2] * ax[0] - ref[0] * ax[2], ref[0] * ax[1] - ref[1] * ax[0]];
    const ul = Math.hypot(...u);
    u = u.map((x) => x / ul);
    const v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const n = Math.max(8, Math.round(2 * Math.PI * r * L * density));
    for (let i = 0; i < n; i++) {
      const t = rand(), th = rand() * 2 * Math.PI;
      const cs = Math.cos(th) * r, sn = Math.sin(th) * r;
      put(a[0] + d[0] * t + u[0] * cs + v[0] * sn, a[1] + d[1] * t + u[1] * cs + v[1] * sn, a[2] + d[2] * t + u[2] * cs + v[2] * sn, c, 0.75 + 0.25 * Math.cos(th));
    }
  };

  const FLOOR = [128, 126, 120], BENCH = [176, 150, 112], LEG = [70, 74, 80];
  const HOUSING = [52, 56, 62], MACHINED = [150, 156, 162];
  const MAST = [232, 232, 228], COLUMN = [40, 92, 170], CAM = [24, 26, 30], YELLOW = [236, 196, 30];

  // Floor
  quad([-1.6, -1.5, 0], [3.2, 0, 0], [0, 2.8, 0], FLOOR);

  // Bench: top slab and four legs
  const T = SAMPLE_TRUTH.benchTop;
  box([-0.7, -0.5, T - 0.04], [0.7, 0.5, T], BENCH, true);
  for (const [x, y] of [[-0.64, -0.44], [0.64, -0.44], [-0.64, 0.44], [0.64, 0.44]]) {
    box([x - 0.03, y - 0.03, 0], [x + 0.03, y + 0.03, T - 0.04], LEG);
  }

  // The part: an axle housing lying on the bench — body, two tubes, a flange
  box([-0.2, -0.16, T], [0.2, 0.16, T + 0.24], HOUSING);
  tube([-0.48, 0, T + 0.12], [-0.2, 0, T + 0.12], 0.07, HOUSING);
  tube([0.2, 0, T + 0.12], [0.48, 0, T + 0.12], 0.07, HOUSING);
  tube([0, 0, T + 0.24], [0, 0, T + 0.29], 0.11, MACHINED);
  tube([-0.5, 0, T + 0.12], [-0.48, 0, T + 0.12], 0.1, MACHINED);
  tube([0.48, 0, T + 0.12], [0.5, 0, T + 0.12], 0.1, MACHINED);

  // Temporary stand: weighted base, blue column, white mast, arm to the camera
  const [mx, my] = SAMPLE_TRUTH.stand.mast;
  const top = SAMPLE_TRUTH.stand.top;
  box([mx - 0.2, my - 0.2, 0], [mx + 0.2, my + 0.2, 0.05], LEG);
  tube([mx, my, 0.05], [mx, my, 1.0], 0.04, COLUMN);
  tube([mx, my, 1.0], [mx, my, top], 0.025, MAST);
  const cam = SAMPLE_TRUTH.camera.center;
  const elbow = [mx - 0.05, my + 0.02, top - 0.04];
  const wrist = [cam[0] + 0.05, cam[1] - 0.07, cam[2] + 0.1];
  tube([mx, my, top - 0.04], elbow, 0.02, MAST);
  tube(elbow, wrist, 0.018, MAST);
  tube(wrist, [cam[0], cam[1] - 0.02, cam[2] + 0.03], 0.014, MAST);
  box([mx - 0.035, my - 0.035, top - 0.07], [mx + 0.035, my + 0.035, top - 0.01], YELLOW, true);

  // The camera: a small dark block. At LiDAR resolution it is little more
  // than a blob, which is why the page asks the user to confirm its pose.
  box([cam[0] - 0.03, cam[1] - 0.05, cam[2] - 0.03], [cam[0] + 0.03, cam[1] + 0.05, cam[2] + 0.03], CAM, true);

  return { positions: Float32Array.from(pos), colors: Uint8Array.from(col), count: pos.length / 3 };
}
