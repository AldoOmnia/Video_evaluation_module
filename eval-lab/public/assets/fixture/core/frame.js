/**
 * Beam model of the skeleton, and the sizing loop that turns it into radii.
 *
 * Each strut is a 3D Euler-Bernoulli beam with a solid circular section. The
 * model answers the question that matters for a fixed camera — how far does
 * the lens move — and drives the generative part: struts are thickened where
 * they carry bending and left thin where they do not, then the whole structure
 * is scaled until the camera's deflection under a 1 g load in its worst
 * direction meets the target set by the Rigidity slider.
 *
 * This is an engineering estimate for comparing variants while dragging a
 * slider. It models the blended joints as rigid points and ignores bolted
 * interface compliance, so treat the numbers as a ranking and a sanity check,
 * and confirm the chosen design in NX before it is built.
 */
import * as V from "./vec.js";

const G_ACC = 9.80665;

export const MATERIALS = {
  al6061: { label: "Aluminium 6061-T6", E: 68.9e9, G: 26e9, rho: 2700 },
  pa12: { label: "PA12 (SLS / MJF)", E: 1.7e9, G: 0.62e9, rho: 1010 },
  ss316l: { label: "Stainless 316L", E: 193e9, G: 77e9, rho: 7990 },
  ti64: { label: "Titanium Ti-6Al-4V", E: 113.8e9, G: 44e9, rho: 4430 },
};

/** Volume of a truncated cone between radii ra and rb over length L. */
const frustumVolume = (ra, rb, L) => (Math.PI * L * (ra * ra + ra * rb + rb * rb)) / 3;

/** 12×12 global stiffness of one beam; returns { k, R, kl } for force recovery. */
function beamStiffness(pa, pb, r, mat) {
  const d = V.sub(pb, pa);
  const L = Math.max(V.len(d), 1e-6);
  const A = Math.PI * r * r;
  const I = (Math.PI * r ** 4) / 4;
  const J = 2 * I;
  const EA = (mat.E * A) / L;
  const GJ = (mat.G * J) / L;
  const EI = mat.E * I;
  const a = (12 * EI) / L ** 3, b = (6 * EI) / L ** 2, c = (4 * EI) / L, e = (2 * EI) / L;

  const kl = new Float64Array(144);
  const set = (i, j, v) => { kl[i * 12 + j] = v; kl[j * 12 + i] = v; };
  // axial
  set(0, 0, EA); set(0, 6, -EA); set(6, 6, EA);
  // torsion
  set(3, 3, GJ); set(3, 9, -GJ); set(9, 9, GJ);
  // bending in the local x-y plane (v, θz)
  set(1, 1, a); set(1, 5, b); set(1, 7, -a); set(1, 11, b);
  set(5, 5, c); set(5, 7, -b); set(5, 11, e);
  set(7, 7, a); set(7, 11, -b); set(11, 11, c);
  // bending in the local x-z plane (w, θy)
  set(2, 2, a); set(2, 4, -b); set(2, 8, -a); set(2, 10, -b);
  set(4, 4, c); set(4, 8, b); set(4, 10, e);
  set(8, 8, a); set(8, 10, b); set(10, 10, c);

  const x = V.scale(d, 1 / L);
  const [y, z] = V.basis(x);
  const R = [x, y, z];

  // k = Tᵀ kl T with T = blockdiag(R, R, R, R)
  const k = new Float64Array(144);
  const tmp = new Float64Array(144);
  for (let bi = 0; bi < 4; bi++) for (let bj = 0; bj < 4; bj++) {
    // tmp block = kl block · R
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += kl[(bi * 3 + i) * 12 + bj * 3 + m] * R[m][j];
      tmp[(bi * 3 + i) * 12 + bj * 3 + j] = s;
    }
  }
  for (let bi = 0; bi < 4; bi++) for (let bj = 0; bj < 4; bj++) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += R[m][i] * tmp[(bi * 3 + m) * 12 + bj * 3 + j];
      k[(bi * 3 + i) * 12 + bj * 3 + j] = s;
    }
  }
  return { k, kl, R, L };
}

/** In-place Cholesky of a dense SPD matrix (lower triangle). False if not SPD. */
function cholesky(A, n) {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0)) return false;
    d = Math.sqrt(d);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      const ri = i * n, rj = j * n;
      for (let k = 0; k < j; k++) s -= A[ri + k] * A[rj + k];
      A[ri + j] = s / d;
    }
  }
  return true;
}

function choleskySolve(Lm, n, b) {
  const x = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let k = 0; k < i; k++) s -= Lm[i * n + k] * x[k];
    x[i] = s / Lm[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= Lm[k * n + i] * x[k];
    x[i] = s / Lm[i * n + i];
  }
  return x;
}

/** Radius a tapered strut behaves like in bending. */
const equivalentRadius = (ra, rb) => ((ra ** 4 + rb ** 4) / 2) ** 0.25;

/**
 * Solve the frame for 1 g applied along -Z, +X and +Y in turn.
 *
 * @returns per-load-case camera displacement and rotation, per-element peak
 *          moment, node masses and a first-mode frequency estimate.
 */
export function solveFrame(sk, mat, cameraMass, extraMass = {}) {
  const nn = sk.nodes.length;
  const dofOf = new Int32Array(nn * 6).fill(-1);
  let nf = 0;
  for (let i = 0; i < nn; i++) {
    if (sk.nodes[i].fixed) continue;
    for (let d = 0; d < 6; d++) dofOf[i * 6 + d] = nf++;
  }

  const K = new Float64Array(nf * nf);
  const mass = new Float64Array(nn);
  mass[sk.iCam] += cameraMass;
  for (const [i, m] of Object.entries(extraMass)) mass[+i] += m;

  const beams = [];
  let structuralMass = 0;
  for (const el of sk.elements) {
    const na = sk.nodes[el.a], nb = sk.nodes[el.b];
    // The camera-to-plate link is a rigid offset, not a part: stiff, massless.
    const r = el.virtual ? 0.04 : equivalentRadius(na.r, nb.r);
    const bm = beamStiffness(na.p, nb.p, r, el.virtual ? MATERIALS.ss316l : mat);
    beams.push(bm);
    if (!el.virtual) {
      const m = mat.rho * frustumVolume(na.r, nb.r, bm.L);
      structuralMass += m;
      mass[el.a] += m / 2;
      mass[el.b] += m / 2;
    }
    const map = [];
    for (let d = 0; d < 6; d++) map.push(dofOf[el.a * 6 + d]);
    for (let d = 0; d < 6; d++) map.push(dofOf[el.b * 6 + d]);
    for (let i = 0; i < 12; i++) {
      if (map[i] < 0) continue;
      for (let j = 0; j < 12; j++) {
        if (map[j] < 0) continue;
        K[map[i] * nf + map[j]] += bm.k[i * 12 + j];
      }
    }
  }

  if (!cholesky(K, nf)) return null;

  const dirs = [[0, 0, -1], [1, 0, 0], [0, 1, 0]];
  const cases = [];
  const moment = new Float64Array(sk.elements.length);
  let f1 = Infinity;
  for (const dir of dirs) {
    const f = new Float64Array(nf);
    for (let i = 0; i < nn; i++) {
      for (let d = 0; d < 3; d++) {
        const q = dofOf[i * 6 + d];
        if (q >= 0) f[q] += mass[i] * G_ACC * dir[d];
      }
    }
    const u = choleskySolve(K, nf, f);
    const disp = (i, d) => { const q = dofOf[i * 6 + d]; return q >= 0 ? u[q] : 0; };

    // Rayleigh quotient with the static shape under a 1 g body load.
    let num = 0, den = 0;
    for (let i = 0; i < nn; i++) {
      const ux = disp(i, 0), uy = disp(i, 1), uz = disp(i, 2);
      num += mass[i] * (ux * dir[0] + uy * dir[1] + uz * dir[2]);
      den += mass[i] * (ux * ux + uy * uy + uz * uz);
    }
    if (den > 0 && num > 0) f1 = Math.min(f1, Math.sqrt((G_ACC * num) / den) / (2 * Math.PI));

    // Peak resultant moment per element, from local end forces.
    for (const [ei, el] of sk.elements.entries()) {
      if (el.virtual) continue;
      const { kl, R } = beams[ei];
      const ul = new Float64Array(12);
      for (let blk = 0; blk < 4; blk++) {
        const node = blk < 2 ? el.a : el.b;
        const off = blk % 2 === 0 ? 0 : 3;
        const g = [disp(node, off), disp(node, off + 1), disp(node, off + 2)];
        for (let i = 0; i < 3; i++) ul[blk * 3 + i] = R[i][0] * g[0] + R[i][1] * g[1] + R[i][2] * g[2];
      }
      let ma = 0, mb = 0;
      for (const [slot, rows] of [[0, [3, 4, 5]], [1, [9, 10, 11]]]) {
        let s = 0;
        for (const row of rows) {
          let fr = 0;
          for (let j = 0; j < 12; j++) fr += kl[row * 12 + j] * ul[j];
          s += fr * fr;
        }
        if (slot === 0) ma = Math.sqrt(s); else mb = Math.sqrt(s);
      }
      moment[ei] = Math.max(moment[ei], ma, mb);
    }

    cases.push({
      dir,
      camDisp: Math.hypot(disp(sk.iCam, 0), disp(sk.iCam, 1), disp(sk.iCam, 2)),
      camTilt: Math.hypot(disp(sk.iCam, 3), disp(sk.iCam, 4), disp(sk.iCam, 5)),
    });
  }

  return {
    cases,
    moment,
    structuralMass,
    worstDisp: Math.max(...cases.map((c) => c.camDisp)),
    sag: cases[0].camDisp,
    tilt: cases[0].camTilt,
    f1: Number.isFinite(f1) ? f1 : 0,
  };
}

/**
 * Rigidity slider (0–100) → allowed camera deflection under 1 g, metres.
 * Log scale from 2 mm (loose) through 0.2 mm at 50 to 0.02 mm (very stiff).
 */
export const targetDeflection = (rigidity) => 2e-3 * 10 ** (-2 * V.clamp(rigidity, 0, 100) / 100);

/**
 * Size every strut. Mutates node radii on `sk` and returns the final solve.
 *
 * @param {number} iterations  fewer while a slider is moving, more once it settles
 */
export function sizeFrame(sk, P, mat, cameraMass, iterations = 4, extraMass = {}) {
  const rMin = P.minDiameter / 2;
  const rMax = Math.max(P.maxDiameter / 2, rMin);
  const target = targetDeflection(P.rigidity);
  const real = sk.elements.map((el, i) => (el.virtual ? -1 : i)).filter((i) => i >= 0);
  const shape = new Float64Array(sk.elements.length).fill(1);
  let s = Math.min(Math.max(0.012, rMin), rMax);

  const apply = () => {
    for (const nd of sk.nodes) nd.r = rMin;
    for (const i of real) {
      const el = sk.elements[i];
      const r = V.clamp(s * shape[i], rMin, rMax);
      const na = sk.nodes[el.a], nb = sk.nodes[el.b];
      na.r = Math.max(na.r, r);
      nb.r = Math.max(nb.r, r);
    }
    // A round cone needs its radii to differ by less than its length.
    for (let pass = 0; pass < 2; pass++) for (const i of real) {
      const el = sk.elements[i];
      const na = sk.nodes[el.a], nb = sk.nodes[el.b];
      const lim = 0.7 * V.dist(na.p, nb.p);
      if (na.r - nb.r > lim) nb.r = na.r - lim;
      if (nb.r - na.r > lim) na.r = nb.r - lim;
    }
  };

  // Deflection falls as a power of the section scale: r⁻⁴ when the camera
  // dominates, nearer r⁻² once the structure's own weight does. The exponent
  // is measured from the last two solves rather than assumed.
  let res = null;
  let power = 3;
  let last = null;
  for (let it = 0; it < iterations; it++) {
    apply();
    res = solveFrame(sk, mat, cameraMass, extraMass);
    if (!res) return null;
    let mMax = 0;
    for (const i of real) mMax = Math.max(mMax, res.moment[i]);
    if (mMax > 0) {
      for (const i of real) {
        // Bending stress goes with M / r³, so equal stress means r ∝ M^(1/3).
        // The floor keeps lightly loaded ties from vanishing.
        const want = Math.max(0.45, Math.cbrt(res.moment[i] / mMax));
        shape[i] = 0.5 * shape[i] + 0.5 * want;
      }
    }
    if (last && Math.abs(Math.log(s / last.s)) > 0.02) {
      power = V.clamp(Math.log(last.d / res.worstDisp) / Math.log(s / last.s), 1.5, 4.5);
    }
    last = { s, d: res.worstDisp };
    s = V.clamp(s * (res.worstDisp / target) ** (1 / power), rMin * 0.5, rMax * 2);
  }
  apply();
  res = solveFrame(sk, mat, cameraMass, extraMass);
  if (!res) return null;
  return { ...res, target, met: res.worstDisp <= target * 1.1 };
}
