/**
 * Camera-support generator — page logic.
 *
 * The page is a thin shell around two things: a three.js viewer, and a worker
 * that owns the geometry (core/*.js). This file wires the seven steps in the
 * side panels to those two and holds the one piece of state that must never be
 * changed by a slider: the locked camera pose.
 *
 * Frame convention everywhere: metres, Z up, the scan's own origin.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as V from "./core/vec.js";
import { cameraFrame, cameraSpecSI, PLATE_MARGIN } from "./core/generate.js";

if (!window.Platform.requireSession()) throw new Error("no session");

const $ = (id) => document.getElementById(id);
const esc = window.Platform.esc;

/* ── State ────────────────────────────────────────────────────────────────── */

const S = {
  schema: null,
  caps: null,
  scan: null, // { positions, colors, count, name, sample, truth, floor, bounds, upAxis }
  mask: null, // Uint8Array — 1 where a point belongs to the temporary arm
  armCount: 0,
  pose: null, // { center, view, up } — the thing that must not move once locked
  brushes: [], // hand corrections to the arm, replayed when a saved setup is reopened
  setupReady: false, // false until a saved setup for this scan has been looked for
  target: null,
  locked: false,
  anchors: [], // { p, n, rms, flat, count }; a ring anchor adds { kind: "ring", rIn, rOut, coverage } and p is its centre
  values: {}, // slider values as shown, plus material and holder
  // Alternative designs for the same camera pose. Each keeps its own anchors
  // and values; S.anchors and S.values are the working copy of the active one.
  variations: [], // { id, name, values, anchors, summary }
  active: null,
  rev: 0, // revision of the saved setup this page started from, as the server counts them
  conflict: false, // the server's copy was changed by someone else since
  // A named configuration (/fixture/<slug>). `link` is set once its scan file
  // is open and this page is saving into it; `linkPending` is what the address
  // asked for, kept so opening the file — or the right file, later — applies it.
  link: null, // { slug, name }
  linkRev: 0,
  linkPending: null, // { slug, name, rev, savedAt, scan, setup }
  linkMissing: "",
  linkWrong: null, // the scan a link wanted, when a different file was opened
  linkCountWarn: 0,
  linkNote: null, // { cls, html } a one-off message, such as a copied link
  links: [],
  sceneReady: false,
  result: null,
  mode: null, // camera | target | anchor | ring | erase | keep
};

/* ── Worker RPC ───────────────────────────────────────────────────────────── */

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const waiting = new Map();
let nextId = 1;
worker.onmessage = (ev) => {
  const { id, type, ...data } = ev.data;
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  if (type === "error") w.reject(new Error(data.message));
  else w.resolve(data);
};
worker.onerror = (ev) => {
  for (const w of waiting.values()) w.reject(new Error(ev.message || "the geometry worker stopped"));
  waiting.clear();
};
const call = (type, payload = {}, transfer = []) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });

/* ── Viewer ───────────────────────────────────────────────────────────────── */

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const view = $("view");
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const cam3 = new THREE.PerspectiveCamera(42, 1, 0.02, 400);
cam3.position.set(2.4, -2.8, 2.0);
const orbit = new OrbitControls(cam3, canvas);
orbit.target.set(0, 0, 0.7);
orbit.enableDamping = false;
orbit.zoomSpeed = 1.2;

let dirty = true;
const redraw = () => { dirty = true; };
orbit.addEventListener("change", redraw);
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  cam3.aspect = w / h;
  cam3.updateProjectionMatrix();
  redraw();
}
new ResizeObserver(resize).observe(view);
(function loop() {
  if (dirty) {
    dirty = false;
    renderer.render(scene, cam3);
  }
  requestAnimationFrame(loop);
})();

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.004;
scene.add(key, key.target);
scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 0.5));

const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.3 }));
ground.receiveShadow = true;
ground.visible = false;
scene.add(ground);

/** Colours come from the platform tokens so both themes work. */
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tokenColor = (name) => new THREE.Color(token(name));

/* Scan points */
/* Round points: a square sprite reads as confetti up close. */
const dot = document.createElement("canvas");
dot.width = dot.height = 32;
{
  const g = dot.getContext("2d");
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(16, 16, 15, 0, Math.PI * 2);
  g.fill();
}
const points = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({ size: 0.009, sizeAttenuation: true, vertexColors: true, map: new THREE.CanvasTexture(dot), alphaTest: 0.5 }),
);
points.frustumCulled = false;
points.visible = false;
scene.add(points);
const SRGB_TO_LINEAR = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = Math.round(255 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}
let baseColors = null; // linear RGB bytes, before the arm tint

/* Generated structure */
const LOOKS = {
  al6061: { color: 0xc5c9ce, metalness: 1.0, roughness: 0.44 },
  pa12: { color: 0xe6e3dc, metalness: 0.0, roughness: 0.86 },
  ss316l: { color: 0xb2b5b9, metalness: 1.0, roughness: 0.32 },
  ti64: { color: 0x8f8b86, metalness: 1.0, roughness: 0.5 },
};
const partMaterial = new THREE.MeshPhysicalMaterial({ ...LOOKS.al6061, envMapIntensity: 1.1 });
const part = new THREE.Mesh(new THREE.BufferGeometry(), partMaterial);
part.castShadow = true;
part.receiveShadow = true;
part.visible = false;
scene.add(part);

const skeleton = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 }),
);
skeleton.renderOrder = 5;
skeleton.visible = false;
scene.add(skeleton);

/* Camera model: +X is the view direction, +Z is up. */
const camGroup = new THREE.Group();
camGroup.visible = false;
scene.add(camGroup);
/* One box per solid of the camera body, as the schema describes it. */
const camBoxGeo = new THREE.BoxGeometry(1, 1, 1);
const camBoxMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.35 });
const camBodies = new THREE.Group();
const camLens = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 32),
  new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.15, metalness: 0.8 }),
);
camLens.rotation.z = -Math.PI / 2;
const camFace = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
const camCone = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }));
/* The room kept behind the camera for its cables, as the generator cut it. */
const camCable = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ dashSize: 0.006, gapSize: 0.004, transparent: true, opacity: 0.7 }));
camCable.visible = false;
camGroup.add(camBodies, camLens, camFace, camCone, camCable);

const anchorGroup = new THREE.Group();
scene.add(anchorGroup);
const targetMark = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ depthTest: false }));
targetMark.renderOrder = 6;
targetMark.visible = false;
scene.add(targetMark);

const gizmo = new TransformControls(cam3, canvas);
gizmo.setSize(0.75);
gizmo.setSpace("local");
gizmo.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });
gizmo.addEventListener("change", redraw);
gizmo.addEventListener("objectChange", () => {
  camGroup.updateMatrixWorld(true);
  const m = camGroup.matrixWorld.elements;
  S.pose = {
    center: camGroup.position.toArray(),
    view: V.norm([m[0], m[1], m[2]]),
    up: V.norm([m[8], m[9], m[10]]),
  };
  // A nudged camera no longer points exactly at the picked target.
  S.target = null;
  targetMark.visible = false;
  renderPoseState();
  scheduleSave();
});
scene.add(gizmo.getHelper());

function applyTheme() {
  const primary = tokenColor("--primary");
  skeleton.material.color.copy(primary);
  camFace.material.color.copy(primary);
  camCone.material.color.copy(primary);
  camCable.material.color.copy(tokenColor("--warn"));
  targetMark.material.color.copy(tokenColor("--warn"));
  for (const g of anchorGroup.children) g.traverse((o) => o.material?.color.copy(primary));
  ground.material.opacity = document.documentElement.classList.contains("light") ? 0.22 : 0.42;
  if (S.scan) paintPoints();
  redraw();
}
window.addEventListener("daedalus:theme", applyTheme);

/* ── Scan ─────────────────────────────────────────────────────────────────── */

const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} k` : String(n));

function setScan(data, name) {
  S.scan = { ...data, name };
  S.mask = new Uint8Array(data.count);
  S.armCount = 0;
  S.pose = null;
  S.target = null;
  S.locked = false;
  S.anchors = [];
  S.brushes = [];
  S.setupReady = false;
  S.variations = [{ id: "v1", name: "Variation 1", values: { ...S.values }, anchors: [], summary: null }];
  S.active = "v1";
  S.rev = 0;
  S.conflict = false;
  // The address still names the link. Whether this file is the one it belongs
  // to is decided once the file is read; until then it is not bound, so a
  // different file cannot be written over it.
  S.link = null;
  S.linkRev = 0;
  S.linkWrong = null;
  S.linkCountWarn = 0;
  lastSaved = "";
  S.sceneReady = false;
  S.result = null;
  setMode(null);
  renderSaveState(null);

  // Colour: the scan's own, or a height ramp when it has none.
  baseColors = new Uint8Array(data.count * 3);
  if (data.colors) {
    for (let i = 0; i < baseColors.length; i++) baseColors[i] = SRGB_TO_LINEAR[data.colors[i]];
  } else {
    const z0 = data.bounds.min[2], span = Math.max(1e-6, data.bounds.max[2] - z0);
    for (let i = 0; i < data.count; i++) {
      const g = SRGB_TO_LINEAR[Math.round(70 + 150 * ((data.positions[i * 3 + 2] - z0) / span))];
      baseColors[i * 3] = baseColors[i * 3 + 1] = baseColors[i * 3 + 2] = g;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(data.count * 3), 3, true));
  points.geometry.dispose();
  points.geometry = geo;
  points.visible = $("t-scan").checked;
  paintPoints();

  ground.position.z = data.floor;
  ground.visible = true;
  part.visible = false;
  skeleton.visible = false;
  camCable.visible = false;
  camGroup.visible = false;
  targetMark.visible = false;
  gizmo.detach();
  anchorGroup.clear();

  $("empty").hidden = true;
  $("toggles").hidden = false;
  $("kpis").hidden = false;
  $("sample-chip").hidden = !data.sample;
  $("scan-chip").hidden = false;
  $("scan-chip").textContent = `${name} · ${fmtCount(data.count)} points`;
  renderScanState();

  frame();
  renderAll();
  if (data.sample) S.setupReady = true;
  else restoreSetup();
}

const ORIENT = {
  "z+": "Z-up",
  "z-": "Z-up file, turned over",
  "y+": "Y-up file, turned to Z-up",
  "y-": "Y-down file, turned to Z-up",
};
function renderScanState() {
  const data = S.scan;
  const size = data.bounds.max.map((v, i) => v - data.bounds.min[i]);
  $("scan-state").innerHTML =
    `<b>${esc(data.name)}</b><br>${fmtCount(data.count)} points · ${size.map((v) => v.toFixed(1)).join(" × ")} m` +
    `<br>${ORIENT[data.orient] ?? "Z-up"} · floor at ${data.floor.toFixed(2)} m` +
    (data.sample
      ? `<br>Made-up station for trying the tool — not a Comer scan.<br><button class="btn" id="btn-sample-setup" style="margin-top:8px">Use its known pose and anchor</button>`
      : `<br>Read in this browser; not uploaded. Only the setup you make on it is saved.` +
        `<br><button class="btn" id="btn-flip" style="margin-top:8px" title="If the station shows upside down, turn the scan over. The camera pose and anchors turn with it.">Flip upside down</button>`);
  $("btn-sample-setup")?.addEventListener("click", applySampleSetup);
  $("btn-flip")?.addEventListener("click", flipScan);
}

/* Which way is up cannot always be read from a file: a Gaussian splat keeps
   the axes of the cameras it was made from. The tool guesses, and this turns
   the scan over when the guess is wrong. */
const halfTurn = (p) => [p[0], -p[1], -p[2]];

/** Turn the points over; what has been placed on them is the caller's business. */
async function turnScan() {
  const d = await call("flip");
  Object.assign(S.scan, { positions: d.positions, floor: d.floor, bounds: d.bounds, orient: d.orient });
  points.geometry.setAttribute("position", new THREE.BufferAttribute(d.positions, 3));
  points.geometry.computeBoundingSphere();
  ground.position.z = d.floor;
  S.sceneReady = false;
  S.result = null;
  part.visible = false;
  skeleton.visible = false;
  renderScanState();
}

/** A setup's coordinates after the scan they were taken on is turned over. */
function turnSetup(s) {
  let pose = s.pose;
  if (pose) {
    pose = { center: halfTurn(pose.center), view: halfTurn(pose.view), up: halfTurn(pose.up) };
    // A camera whose roll was never set by hand stays the right way up
    // instead of ending on its back.
    if (V.dist(cameraFrame(s.pose.center, s.pose.view).up, s.pose.up) < 1e-4) pose.up = cameraFrame(pose.center, pose.view).up;
  }
  const turnAnchors = (list) => (list ?? []).map((a) => ({ ...a, p: halfTurn(a.p), n: halfTurn(a.n) }));
  return {
    ...s, pose,
    target: s.target ? halfTurn(s.target) : s.target,
    anchors: turnAnchors(s.anchors),
    brushes: (s.brushes ?? []).map((b) => ({ ...b, center: halfTurn(b.center) })),
    ...(s.variations ? { variations: s.variations.map((v) => ({ ...v, anchors: turnAnchors(v.anchors) })) } : {}),
  };
}

async function flipScan() {
  if (!S.scan || S.scan.sample) return;
  setMode(null);
  setGizmo(null);
  await turnScan();
  commitVariation();
  const t = turnSetup({ pose: S.pose, target: S.target, anchors: S.anchors, brushes: S.brushes, variations: S.variations });
  S.target = t.target;
  S.anchors = t.anchors;
  S.brushes = t.brushes;
  S.variations = t.variations;
  if (t.pose) setPose(t.pose.center, t.pose.view, t.pose.up);
  renderAll();
  frame();
  scheduleScene();
}

/** Write display colours: the scan's own, with the arm tinted so it reads as going away. */
function paintPoints() {
  const attr = points.geometry.getAttribute("color");
  if (!attr) return;
  const out = attr.array;
  out.set(baseColors);
  if (S.armCount > 0) {
    const w = tokenColor("--warn");
    const tr = Math.round(w.r * 255), tg = Math.round(w.g * 255), tb = Math.round(w.b * 255);
    for (let i = 0; i < S.mask.length; i++) {
      if (!S.mask[i]) continue;
      out[i * 3] = (out[i * 3] + tr * 3) >> 2;
      out[i * 3 + 1] = (out[i * 3 + 1] + tg * 3) >> 2;
      out[i * 3 + 2] = (out[i * 3 + 2] + tb * 3) >> 2;
    }
  }
  attr.needsUpdate = true;
  // "Arm" off draws only the points that stay.
  if (!$("t-arm").checked && S.armCount > 0) {
    const keep = new Uint32Array(S.mask.length - S.armCount);
    for (let i = 0, k = 0; i < S.mask.length; i++) if (!S.mask[i]) keep[k++] = i;
    points.geometry.setIndex(new THREE.BufferAttribute(keep, 1));
  } else {
    points.geometry.setIndex(null);
  }
  redraw();
}

function frame() {
  if (!S.scan) return;
  let c, r;
  if (S.pose) {
    // Around the work: the camera and wherever the support lands.
    const pts = [S.pose.center, ...S.anchors.map((a) => a.p)];
    if (S.target) pts.push(S.target);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    c = lo.map((v, k) => (v + hi[k]) / 2);
    r = Math.max(0.7, V.dist(lo, hi) * 0.75);
  } else {
    const b = S.scan.bounds;
    c = b.min.map((v, k) => (v + b.max[k]) / 2);
    r = Math.min(6, V.dist(b.min, b.max) * 0.5);
  }
  const dir = V.norm(V.sub(cam3.position.toArray(), orbit.target.toArray()), [0.55, -0.65, 0.5]);
  orbit.target.fromArray(c);
  cam3.position.fromArray(V.addScaled(c, dir, r * 2.3));
  cam3.near = Math.max(0.01, r / 200);
  cam3.far = r * 80;
  cam3.updateProjectionMatrix();
  orbit.update();
  placeLight(c, r);
  redraw();
}

function placeLight(c, r) {
  key.target.position.fromArray(c);
  key.position.fromArray(V.add(c, [r * 0.9, -r * 1.2, r * 2.4]));
  const s = key.shadow.camera;
  s.left = s.bottom = -r * 1.6;
  s.right = s.top = r * 1.6;
  s.near = 0.05;
  s.far = r * 8;
  s.updateProjectionMatrix();
}

async function loadFile(file) {
  if (!file) return;
  $("scan-state").textContent = `Reading ${file.name}…`;
  try {
    const buffer = await file.arrayBuffer();
    const data = await call("load", { buffer }, [buffer]);
    setScan(data, file.name);
  } catch (err) {
    $("scan-state").innerHTML = `<span class="state err">Could not read that file: ${esc(err.message)}</span>`;
  }
}
async function loadSample() {
  $("scan-state").textContent = "Building the sample scan…";
  setScan(await call("sample"), "Sample station");
}

/* ── Camera pose ──────────────────────────────────────────────────────────── */

const camModel = () => S.schema.cameras.find((c) => c.id === $("cam-model").value) ?? S.schema.cameras[0];
/** The camera as the generator takes it. A model with a drawn body uses the
    drawing; a plain envelope uses what is typed in the fields. */
const camSpec = () => {
  const drawn = cameraSpecSI(camModel());
  const fixed = Boolean(drawn.body);
  return {
    size: fixed ? drawn.size : [Number($("cam-l").value), Number($("cam-w").value), Number($("cam-h").value)].map((v) => v / 1000),
    holes: fixed ? drawn.holes : [Number($("cam-hu").value), Number($("cam-hv").value)].map((v) => v / 1000),
    mass: Number($("cam-mass").value) / 1000,
    mountFace: fixed ? drawn.mountFace : $("cam-face").value,
    body: drawn.body,
    mount: drawn.mount,
    grip: drawn.grip,
    fovDeg: S.schema.lenses.find((l) => l.id === $("cam-lens").value)?.fovDeg ?? 29,
  };
};
const camRange = () => (S.target && S.pose ? V.dist(S.pose.center, S.target) : 0.6);

function setPose(center, viewDir, upHint) {
  const f = cameraFrame(center, viewDir, upHint);
  S.pose = { center: f.center, view: f.view, up: f.up };
  renderCamera();
}

/** Push S.pose and the camera spec into the 3D model. */
function renderCamera() {
  if (!S.pose) { camGroup.visible = false; return; }
  const spec = camSpec();
  const { center, view: x, up: z } = S.pose;
  const y = V.cross(z, x);
  camGroup.matrixAutoUpdate = true;
  camGroup.position.fromArray(center);
  camGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z)));
  camGroup.updateMatrixWorld(true);
  const [L, W, H] = spec.size;
  // The group's Y is the camera's left (up × view), so "across" flips sign.
  const solids = spec.body ?? [{ c: [0, 0, 0], half: [L / 2, W / 2, H / 2] }];
  while (camBodies.children.length > solids.length) camBodies.remove(camBodies.children[camBodies.children.length - 1]);
  while (camBodies.children.length < solids.length) {
    const m = new THREE.Mesh(camBoxGeo, camBoxMat);
    m.castShadow = true;
    camBodies.add(m);
  }
  solids.forEach((b, i) => {
    camBodies.children[i].position.set(b.c[0], -b.c[1], b.c[2]);
    camBodies.children[i].scale.set(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2);
  });
  const lr = Math.min(W, H) * 0.3;
  camLens.scale.set(lr, 0.014, lr);
  camLens.position.set(L / 2 + 0.007, 0, 0);

  // Outline of where the plate bolts on.
  let face;
  if (spec.mount) {
    // The plate's own footprint, at the drawn bolt pattern.
    const FACES = {
      bottom: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] }, top: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
      back: { u: [0, 1, 0], v: [0, 0, 1], n: [-1, 0, 0] },
      left: { u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] }, right: { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
    };
    const f = FACES[spec.mount.face] ?? FACES.bottom;
    const o = V.addScaled([spec.mount.at[0], -spec.mount.at[1], spec.mount.at[2]], f.n, 0.0006);
    const hu = spec.holes[0] / 2 + PLATE_MARGIN, hv = spec.holes[1] / 2 + PLATE_MARGIN;
    face = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => V.addScaled(V.addScaled(o, f.u, a * hu), f.v, b * hv));
  } else {
    face = {
      bottom: [[L / 2, W / 2, -H / 2], [-L / 2, W / 2, -H / 2], [-L / 2, -W / 2, -H / 2], [L / 2, -W / 2, -H / 2]],
      top: [[L / 2, W / 2, H / 2], [-L / 2, W / 2, H / 2], [-L / 2, -W / 2, H / 2], [L / 2, -W / 2, H / 2]],
      back: [[-L / 2, W / 2, H / 2], [-L / 2, -W / 2, H / 2], [-L / 2, -W / 2, -H / 2], [-L / 2, W / 2, -H / 2]],
      left: [[L / 2, W / 2, H / 2], [-L / 2, W / 2, H / 2], [-L / 2, W / 2, -H / 2], [L / 2, W / 2, -H / 2]],
      right: [[L / 2, -W / 2, H / 2], [-L / 2, -W / 2, H / 2], [-L / 2, -W / 2, -H / 2], [L / 2, -W / 2, -H / 2]],
    }[spec.mountFace].map((p) => p.map((x) => x * 1.02));
  }
  camFace.geometry.setFromPoints(face.map((p) => new THREE.Vector3(...p)));

  // The keep-out cone, drawn exactly as the generator uses it.
  const range = camRange();
  const tan = Math.tan(((spec.fovDeg / 2) * Math.PI) / 180);
  const seg = [];
  const N = 40;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * 2 * Math.PI, a1 = ((i + 1) / N) * 2 * Math.PI;
    const r = range * tan;
    seg.push(L / 2 + range, Math.cos(a0) * r, Math.sin(a0) * r, L / 2 + range, Math.cos(a1) * r, Math.sin(a1) * r);
    if (i % 10 === 0) seg.push(L / 2, 0, 0, L / 2 + range, Math.cos(a0) * r, Math.sin(a0) * r);
  }
  camCone.geometry.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  camCone.visible = $("t-cone").checked;
  camGroup.visible = true;
  if (S.target) { targetMark.position.fromArray(S.target); targetMark.visible = true; }
  redraw();
}

function renderPoseState() {
  const chip = $("pose-chip");
  const lock = $("btn-lock");
  if (!S.pose) {
    chip.textContent = "not placed"; chip.className = "chip";
    lock.disabled = true; lock.textContent = "Lock pose";
    $("pose-state").textContent = "Pick the camera body in the scan to begin.";
    return;
  }
  const c = S.pose.center.map((v) => Math.round(v * 1000));
  const tilt = (Math.acos(V.clamp(-S.pose.view[2], -1, 1)) * 180) / Math.PI;
  const lines = [
    `Position <b>${c[0]} · ${c[1]} · ${c[2]}</b> mm`,
    `Aim <b>${tilt.toFixed(1)}°</b> from straight down${S.target ? ` · <b>${Math.round(camRange() * 1000)}</b> mm to target` : " · no target picked"}`,
  ];
  if (S.locked) {
    chip.textContent = "locked"; chip.className = "chip ok";
    lock.textContent = "Unlock";
    lines.push("Locked. Sliders reshape the support only.");
  } else {
    chip.textContent = "not locked"; chip.className = "chip warn";
    lock.textContent = "Lock pose";
    lines.push(S.target ? "Check the model against the scanned camera, then lock." : "Pick what the camera looks at, or rotate it by hand.");
  }
  lock.disabled = false;
  $("pose-state").innerHTML = lines.join("<br>");
  for (const b of [$("btn-gizmo-move"), $("btn-gizmo-rot"), $("btn-pick-camera"), $("btn-pick-target"), $("btn-locate")]) b.disabled = S.locked;
  refreshLocateButton();
}

function setGizmo(mode) {
  const on = mode && !S.locked && S.pose && !(gizmo.object && gizmo.mode === mode);
  if (on) {
    gizmo.setMode(mode);
    gizmo.attach(camGroup);
  } else {
    gizmo.detach();
  }
  $("btn-gizmo-move").classList.toggle("is-on", Boolean(on) && mode === "translate");
  $("btn-gizmo-rot").classList.toggle("is-on", Boolean(on) && mode === "rotate");
  redraw();
}

function toggleLock() {
  if (!S.pose) return;
  S.locked = !S.locked;
  setMode(null);
  setGizmo(null);
  if (!S.locked) {
    // The structure was built for the old pose; do not leave it on screen
    // looking current.
    S.sceneReady = false;
    S.result = null;
    part.visible = false;
    skeleton.visible = false;
    camCable.visible = false;
  }
  renderAll();
  scheduleScene();
}

/* ── Temporary arm ────────────────────────────────────────────────────────── */

function adoptMask(res) {
  S.mask = res.mask;
  S.armCount = res.count;
  paintPoints();
  renderArmState();
  scheduleScene();
  scheduleSave();
}
async function findArm() {
  if (!S.pose) return;
  S.brushes = []; // a fresh search replaces the mask the corrections were made on
  $("arm-chip").textContent = "searching"; $("arm-chip").className = "chip";
  try {
    adoptMask(await call("arm", { seed: S.pose.center, reach: Number($("reach").value) }));
  } catch (err) {
    $("arm-state").innerHTML = `<span class="state err">${esc(err.message)}</span>`;
  }
}
function renderArmState() {
  const chip = $("arm-chip");
  if (!S.pose) { chip.textContent = "not found"; chip.className = "chip"; return; }
  if (S.armCount === 0) {
    chip.textContent = "nothing taken"; chip.className = "chip warn";
    $("arm-state").textContent = "No connected material found at the camera. Use Mark as arm on the stand, or leave it: the support will simply route around it.";
  } else {
    const pct = (100 * S.armCount) / S.scan.count;
    chip.textContent = `${fmtCount(S.armCount)} points`; chip.className = "chip ok";
    $("arm-state").innerHTML = `<b>${S.armCount.toLocaleString("en-US")}</b> of ${S.scan.count.toLocaleString("en-US")} points (${pct.toFixed(1)}%) tinted in the view and left out of the obstacle map. Correct it with the two buttons above if it took too much or too little.`;
  }
}

/* ── Anchors ──────────────────────────────────────────────────────────────── */

function renderAnchors() {
  anchorGroup.clear();
  const primary = tokenColor("--primary");
  for (const a of S.anchors) {
    const g = new THREE.Group();
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.09)]),
      new THREE.LineBasicMaterial({ color: primary, depthTest: false }),
    );
    stem.renderOrder = 6;
    g.add(stem);
    if (a.kind === "ring") {
      // The edges of the round face as fitted, so the fit can be checked against the points.
      for (const r of [a.rIn, a.rOut]) {
        if (!(r > 0)) continue;
        const pts = Array.from({ length: 120 }, (_, i) => new THREE.Vector3(r * Math.cos((i / 120) * 2 * Math.PI), r * Math.sin((i / 120) * 2 * Math.PI), 0));
        const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: primary, depthTest: false }));
        edge.renderOrder = 6;
        g.add(edge);
      }
    } else {
      const mark = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.004, 8, 40), new THREE.MeshBasicMaterial({ color: primary, depthTest: false }));
      mark.renderOrder = 6;
      g.add(mark);
    }
    g.position.fromArray(a.p);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...a.n));
    anchorGroup.add(g);
  }
  const list = $("anchor-list");
  list.innerHTML = S.anchors
    .map((a, i) => {
      const tilt = (Math.acos(V.clamp(a.n[2], -1, 1)) * 180) / Math.PI;
      const kind = tilt < 20 ? "horizontal" : tilt > 70 && tilt < 110 ? "vertical" : `${tilt.toFixed(0)}° incline`;
      let detail, warn = !a.flat;
      if (a.kind === "ring") {
        const d = (r) => Math.round(r * 2000);
        const partial = a.coverage < 0.6;
        warn = partial;
        detail = `ring · ${kind} face ${a.rIn > 0 ? `Ø ${d(a.rIn)}–${d(a.rOut)}` : `Ø ${d(a.rOut)}`} mm · flat to ${(a.rms * 1000).toFixed(1)} mm` +
          (partial ? ` · scan shows ${Math.round(a.coverage * 100)}% of the way round` : "");
      } else {
        detail = a.flat ? `${kind} · flat to ${(a.rms * 1000).toFixed(1)} mm` : `${kind} · uneven, ${Number.isFinite(a.rms) ? (a.rms * 1000).toFixed(0) + " mm rms" : "too few points"}`;
      }
      return `<li class="${warn ? "warn" : ""}"><span class="id">A${i + 1}</span><span>${detail}</span><button data-remove="${i}" aria-label="Remove anchor A${i + 1}">×</button></li>`;
    })
    .join("");
  const chip = $("anchor-chip");
  chip.textContent = S.anchors.length ? `${S.anchors.length} set` : "none";
  chip.className = S.anchors.length ? "chip ok" : "chip";
  const uneven = S.anchors.filter((a) => !a.flat).length;
  $("anchor-state").className = uneven ? "state warn" : "state";
  $("anchor-state").textContent = !S.anchors.length
    ? "No anchors yet."
    : uneven
      ? `${uneven} anchor${uneven > 1 ? "s sit" : " sits"} on a surface the scan does not show as flat. The foot is drawn on the fitted plane; check the real surface before relying on it.`
      : !S.locked
        ? "Lock the camera pose to generate the support."
        : S.anchors.some((a) => a.kind === "ring")
          ? "The ring sits on the round face as fitted (outlined in the view) and the legs land on it under the camera. Its fixing holes are not drawn: take them from the drawing of the part."
          : "Feet are placed on the fitted plane at each anchor.";
  redraw();
}

/* ── Picking on the scan ──────────────────────────────────────────────────── */

const HINTS = {
  camera: "Click the camera body in the scan · Esc to cancel",
  target: "Click the spot the camera looks at · Esc to cancel",
  anchor: "Click a flat surface to bolt to · Esc to cancel",
  ring: "Click the flat round face the ring should sit on · Esc to cancel",
  erase: "Click scan points that belong to the old arm · Esc when done",
  keep: "Click scan points that should stay · Esc when done",
};
function setMode(mode) {
  S.mode = S.mode === mode ? null : mode;
  if (S.mode) setGizmo(null);
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("is-on", b.dataset.mode === S.mode));
  $("hint").hidden = !S.mode;
  $("hint").textContent = S.mode ? HINTS[S.mode] : "";
  view.classList.toggle("is-picking", Boolean(S.mode));
}

const raycaster = new THREE.Raycaster();
/** Nearest scan point under a screen position, or null. `ndc` is −1…1. */
function pickAt(ndc, camera = cam3, { skipArm = false } = {}) {
  if (!S.scan) return null;
  raycaster.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), camera);
  // Wider the further away, so distant points are still hittable.
  const d = camera.position.distanceTo(orbit.target);
  raycaster.params.Points.threshold = V.clamp(d * 0.006, 0.008, 0.06);
  const hits = raycaster.intersectObject(points, false).filter((h) => !(skipArm && S.mask[h.index]));
  if (!hits.length) return null;
  // Of the points near the front, the one closest to the ray.
  const front = hits[0].distance;
  let best = hits[0];
  for (const h of hits) {
    if (h.distance > front + 0.06) break;
    if (h.distanceToRay < best.distanceToRay) best = h;
  }
  return { p: best.point.toArray(), index: best.index };
}

let down = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
canvas.addEventListener("pointerup", async (e) => {
  if (!down || down.button !== 0 || !S.mode || gizmo.dragging) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = [((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)];
  const hit = pickAt(ndc, cam3, { skipArm: S.mode === "anchor" || S.mode === "ring" || S.mode === "target" });
  if (!hit) return;
  try {
    await handlePick(S.mode, hit.p);
  } catch (err) {
    $("hint").textContent = err.message;
  }
});

async function handlePick(mode, p) {
  if (mode === "camera") {
    // A click lands on the surface of the blob; its middle is a better centre.
    const { p: c } = await call("blob", { center: p, radius: 0.06 });
    setPose(c, S.target ? V.sub(S.target, c) : [0, 0, -1]);
    setMode(S.target ? null : "target");
    renderAll();
    findArm();
  } else if (mode === "target") {
    if (!S.pose) throw new Error("Pick the camera first");
    S.target = p;
    setPose(S.pose.center, V.sub(p, S.pose.center));
    setMode(null);
    renderAll();
  } else if (mode === "anchor") {
    if (S.anchors.length >= 4) throw new Error("Four anchors is the limit — remove one first");
    const fit = await call("plane", { center: p, radius: 0.08, toward: S.pose ? S.pose.center : V.add(p, [0, 0, 1]) });
    S.anchors.push({ p: fit.p, n: fit.n, rms: fit.rms, flat: fit.flat, count: fit.count });
    setMode(null);
    renderAll();
    scheduleScene();
  } else if (mode === "ring") {
    if (S.anchors.length >= 4) throw new Error("Four anchors is the limit — remove one first");
    const fit = await call("ring", { center: p, toward: S.pose ? S.pose.center : V.add(p, [0, 0, 1]) });
    if (!fit.ok) throw new Error(`No ring placed: ${fit.reason}`);
    S.anchors.push({ kind: "ring", p: fit.c, n: fit.n, rIn: fit.rIn, rOut: fit.rOut, rms: fit.rms, flat: true, count: fit.count, coverage: fit.coverage });
    setMode(null);
    renderAll();
    scheduleScene();
  } else if (mode === "erase" || mode === "keep") {
    const stroke = { center: p, radius: 0.08, value: mode === "erase" ? 1 : 0 };
    S.brushes.push(stroke);
    if (S.brushes.length > 400) S.brushes.shift();
    adoptMask(await call("brush", stroke));
  }
}

/* ── Auto-locate (vision model) ───────────────────────────────────────────── */

function refreshLocateButton() {
  const b = $("btn-locate");
  const cap = S.caps?.locate;
  if (!cap?.available) {
    b.disabled = true;
    b.title = cap?.reason ? `Unavailable: ${cap.reason}` : "Checking the server…";
  } else {
    b.title = "Send three renders of the current view to the vision model and let it point at the camera and its target";
  }
}

async function autoLocate() {
  if (!S.scan || !S.caps?.locate?.available) return;
  const state = $("locate-state");
  state.hidden = false;
  state.className = "state";
  state.textContent = "Rendering three views and asking the vision model…";
  $("btn-locate").disabled = true;

  // Render the scan alone, from the current view and two swung round it.
  const hidden = [part, skeleton, camGroup, anchorGroup, targetMark, gizmo.getHelper()].filter((o) => o.visible);
  hidden.forEach((o) => { o.visible = false; });
  const shots = [];
  for (const [name, deg] of [["current", 0], ["swung left", 55], ["swung right", -55]]) {
    const c = cam3.clone();
    const off = c.position.clone().sub(orbit.target).applyAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180);
    c.position.copy(orbit.target).add(off);
    c.lookAt(orbit.target);
    c.updateMatrixWorld(true);
    renderer.render(scene, c);
    shots.push({ name, camera: c, image: canvas.toDataURL("image/jpeg", 0.86).split(",")[1] });
  }
  hidden.forEach((o) => { o.visible = true; });
  redraw();

  try {
    const res = await fetch("/api/fixture/locate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ views: shots.map(({ name, image }) => ({ name, image })) }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "the server did not answer" }));
    if (!data.ok) throw new Error(data.error);

    // Turn each 2D answer back into a point on the scan, then keep the place
    // most views agree on.
    const found = { camera: [], target: [] };
    data.views.forEach((v, i) => {
      for (const what of ["camera", "target"]) {
        if (!v[what]) continue;
        const hit = pickAt([v[what][0] * 2 - 1, -(v[what][1] * 2 - 1)], shots[i].camera);
        if (hit) found[what].push({ p: hit.p, confidence: v.confidence, view: v.view });
      }
    });
    const agree = (list) => {
      let best = null;
      for (const a of list) {
        const votes = list.filter((b) => V.dist(a.p, b.p) < 0.25).length;
        if (!best || votes > best.votes || (votes === best.votes && a.confidence > best.confidence)) best = { ...a, votes };
      }
      return best;
    };
    const camHit = agree(found.camera), tgtHit = agree(found.target);
    if (!camHit) {
      state.className = "state warn";
      state.textContent = "The vision model could not make out the camera in these views. Frame the station more closely and try again, or pick it by hand.";
      return;
    }
    if (tgtHit) S.target = tgtHit.p;
    const { p: c } = await call("blob", { center: camHit.p, radius: 0.06 });
    setPose(c, S.target ? V.sub(S.target, c) : [0, 0, -1]);
    renderAll();
    findArm();
    state.className = camHit.votes >= 2 ? "state" : "state warn";
    state.innerHTML =
      `Proposed by ${esc(data.model)}: camera from <b>${camHit.votes} of ${shots.length}</b> views (confidence ${camHit.confidence.toFixed(2)})` +
      (tgtHit ? `, target from <b>${tgtHit.votes} of ${shots.length}</b>.` : ", no target found.") +
      ` This is a suggestion from a picture of the scan — check it against the points and adjust before locking.`;
  } catch (err) {
    state.className = "state err";
    state.textContent = `Auto-locate failed: ${err.message}`;
  } finally {
    $("btn-locate").disabled = S.locked;
  }
}

/* ── Scene → generate ─────────────────────────────────────────────────────── */

let sceneTimer = null;
function scheduleScene() {
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(pushScene, 120);
}
async function pushScene() {
  if (!S.locked || !S.pose || S.anchors.length === 0) {
    S.sceneReady = false;
    renderAll();
    return;
  }
  const spec = camSpec();
  const f = cameraFrame(S.pose.center, S.pose.view, S.pose.up);
  setGenChip("mapping obstacles", "");
  try {
    await call("scene", {
      camera: { ...f, size: spec.size, mass: spec.mass, fovDeg: spec.fovDeg, range: camRange(), body: spec.body, mount: spec.mount, grip: spec.grip },
      mountFace: spec.mountFace,
      holes: spec.holes,
      anchors: S.anchors.map((a) => (a.kind === "ring" ? { kind: "ring", p: a.p, n: a.n, rIn: a.rIn, rOut: a.rOut } : { p: a.p, n: a.n })),
    });
    S.sceneReady = true;
    renderAll();
    requestGenerate("settle");
  } catch (err) {
    S.sceneReady = false;
    setGenChip("failed", "warn");
    renderAll();
  }
}

let genBusy = false, genPending = null, settleTimer = null;
function requestGenerate(quality) {
  if (!S.sceneReady) return;
  if (genBusy) { genPending = quality; return; }
  genBusy = true;
  if (quality !== "drag") $("kpis").dataset.busy = "";
  call("generate", { values: { ...S.values }, quality })
    .then((r) => showResult(r))
    .catch((err) => { setGenChip(err.message.slice(0, 60), "warn"); })
    .finally(() => {
      genBusy = false;
      delete $("kpis").dataset.busy;
      if (genPending) { const q = genPending; genPending = null; requestGenerate(q); }
    });
}
/** A slider moved: redraw coarsely now, and finely once it stops. */
function valuesChanged() {
  scheduleSave();
  requestGenerate("drag");
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settleTimer = null; requestGenerate("settle"); }, 240);
}

function setGenChip(text, cls) {
  $("gen-chip").textContent = text;
  $("gen-chip").className = `chip ${cls}`.trim();
}

function showResult(r) {
  S.result = r;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(r.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
  geo.computeBoundingSphere();
  part.geometry.dispose();
  part.geometry = geo;
  part.visible = true;
  const look = LOOKS[r.metrics.material] ?? LOOKS.al6061;
  partMaterial.color.set(look.color);
  partMaterial.metalness = look.metalness;
  partMaterial.roughness = look.roughness;
  skeleton.geometry.dispose();
  skeleton.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(r.lines, 3));
  skeleton.visible = $("t-skel").checked;
  // The cable room is in the camera's frame; the group's Y is the camera's left.
  const cb = r.holder?.cable;
  if (cb) {
    const box = new THREE.BoxGeometry(cb.x[1] - cb.x[0], cb.y[1] - cb.y[0], cb.z[1] - cb.z[0]);
    camCable.geometry.dispose();
    camCable.geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    camCable.position.set((cb.x[0] + cb.x[1]) / 2, -(cb.y[0] + cb.y[1]) / 2, (cb.z[0] + cb.z[1]) / 2);
    camCable.computeLineDistances();
  }
  camCable.visible = Boolean(cb);
  placeLight(geo.boundingSphere.center.toArray(), Math.max(0.5, geo.boundingSphere.radius));
  renderMetrics(r);
  renderHolderState();
  if (r.quality === "settle") {
    const v = liveVariation();
    if (v) {
      v.summary = { mass: r.metrics.mass, deflection: r.metrics.deflection, met: r.metrics.met };
      renderVariations();
    }
  }
  redraw();
}

function renderMetrics(r) {
  const m = r.metrics;
  const mm = (v, d = 2) => (v * 1000).toFixed(d);
  const set = (id, value, unit, cls = "") => {
    $(id).className = `v ${cls}`.trim();
    $(id).innerHTML = `${value}<span class="u">${unit}</span>`;
  };
  set("k-defl", mm(m.deflection, m.deflection < 1e-4 ? 3 : 2), "mm", m.met ? "ok" : "warn");
  $("n-defl").textContent = `target ${mm(m.target, m.target < 1e-4 ? 3 : 2)} mm · ${m.met ? "met" : "not met"}`;
  set("k-tilt", (m.tilt * 1000).toFixed(2), "mrad");
  $("n-tilt").textContent = `under gravity · sag ${mm(m.sag)} mm`;
  set("k-freq", m.frequency.toFixed(0), "Hz", m.frequency < 15 ? "warn" : "");
  $("n-freq").textContent = "beam-model estimate";
  const grams = m.mass * 1000;
  set("k-mass", grams >= 1000 ? (grams / 1000).toFixed(2) : grams.toFixed(0), grams >= 1000 ? "kg" : "g");
  const mat = S.schema.materials.find((x) => x.id === m.material);
  $("n-mass").textContent = `${mat?.short ?? m.material} · carries ${Math.round(camSpec().mass * 1000)} g`;
  const gaps = [m.clearanceScan, m.clearanceView].filter((v) => v != null);
  const least = gaps.length ? Math.min(...gaps) : null;
  // The router keeps the asked clearance where it can; where it cannot, say so
  // on the card rather than leaving the slider's number looking like a promise.
  const asked = S.values.clearance / 1000;
  const short = least != null && least < asked - 5e-4;
  set("k-clear", least == null ? "—" : mm(least, 0), "mm", least != null && least < 0 ? "err" : short ? "warn" : "");
  $("n-clear").textContent = `scan ${m.clearanceScan == null ? "n/a" : mm(m.clearanceScan, 0)} · view ${m.clearanceView == null ? "n/a" : mm(m.clearanceView, 0)} mm${short ? ` · under the ${mm(asked, 0)} asked` : ""}`;
  set("k-tris", m.triangles >= 1000 ? `${(m.triangles / 1000).toFixed(0)}k` : m.triangles, "tris");
  const cell = { drag: 4, settle: 2, export: 1 }[r.quality];
  $("n-tris").textContent = `${cell} mm cells${r.quality === "drag" ? " · preview" : ""}${m.holesShown ? "" : " · small holes at export"}`;

  if (m.pieces > 1) setGenChip(`in ${m.pieces} pieces`, "warn");
  else if (least != null && least < 0) setGenChip("touches the scan", "warn");
  else if (!m.met) setGenChip("target not met", "warn");
  else if (short) setGenChip("clearance short", "warn");
  else setGenChip("generated", "ok");
}

/* ── Sliders ──────────────────────────────────────────────────────────────── */

const fmtValue = (s, v) => {
  const dec = s.step >= 1 ? 0 : 1;
  return Number(v).toFixed(dec);
};
/** What the rigidity number means in millimetres — same formula as core/frame.js. */
const rigidityTarget = (v) => 2 * 10 ** ((-2 * v) / 100);

function paintSlider(s) {
  const input = $(`s-${s.id}`);
  const v = Number(input.value);
  input.style.setProperty("--fill", `${((v - s.min) / (s.max - s.min)) * 100}%`);
  const unit = s.id === "rigidity" ? `≤ ${rigidityTarget(v).toFixed(v > 60 ? 3 : 2)} mm` : s.unit;
  $(`v-${s.id}`).innerHTML = `${fmtValue(s, v)}${unit ? `<span class="u">${unit}</span>` : ""}`;
}

function buildSliders() {
  for (const group of ["main", "advanced"]) {
    $(`sliders-${group}`).innerHTML = S.schema.sliders
      .filter((s) => s.group === group)
      .map(
        (s) => `<label class="slider" id="w-${s.id}" title="${esc(s.help)}">
          <span class="slider-head"><span class="slider-name">${esc(s.label)}</span><output class="slider-val" id="v-${s.id}"></output></span>
          <input type="range" id="s-${s.id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.default}" />
        </label>`,
      )
      .join("");
  }
  for (const s of S.schema.sliders) {
    S.values[s.id] = s.default;
    paintSlider(s);
    $(`s-${s.id}`).addEventListener("input", (e) => {
      S.values[s.id] = Number(e.target.value);
      $(`w-${s.id}`).classList.remove("is-changed");
      paintSlider(s);
      valuesChanged();
    });
  }
  $("material").innerHTML = S.schema.materials.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
  $("material").value = S.values.material = S.schema.defaultMaterial;
  $("material").addEventListener("change", (e) => {
    S.values.material = e.target.value;
    requestGenerate("settle");
    scheduleSave();
  });
  $("holder").innerHTML = S.schema.holders.map((h) => `<option value="${h.id}" title="${esc(h.help)}">${esc(h.label)}</option>`).join("");
  $("holder").value = S.values.holder = S.schema.defaultHolder;
  $("holder").addEventListener("change", (e) => {
    S.values.holder = e.target.value;
    renderAll();
    requestGenerate("settle");
  });
}

/** Whether this camera can be wrapped, and if not, why. */
function holderSupport() {
  const c = camModel();
  if (c.body_mm && c.grip_mm && c.mount_mm) return { ok: true };
  return { ok: false, reason: `${c.label} is entered as an envelope, with no drawn body to size a cradle or sleeve to` };
}

/** Under the holder control: what was actually built, in millimetres. */
function renderHolderState() {
  const el = $("holder-state");
  const support = holderSupport();
  const h = S.result?.metrics.holder;
  const mm = (v) => (v * 1000).toFixed(v < 0.01 ? 1 : 0);
  const thread = camModel().holeThread ?? "M3";
  let text;
  if (!support.ok) text = `Plate only: ${esc(support.reason)}.`;
  else if (!h || h.asked !== S.values.holder) text = esc(S.schema.holders.find((x) => x.id === S.values.holder)?.help ?? "");
  else if (h.style === "plate") text = `The camera sits on a flat plate and is held by its four ${thread} screws alone.`;
  else {
    text =
      `${h.style === "sleeve" ? "Sleeve" : "Cradle"} round <b>${mm(h.grip)} mm</b> of the body, walls ${mm(h.wall)} mm` +
      (h.style === "sleeve" ? ". The body slides in connectors first until the front of the camera meets it" : ", open above") +
      `. Four ${thread} screws through the floor hold it in. The last <b>${mm(h.rearFree)} mm</b> of the camera, connectors included, is left uncovered.`;
  }
  if (support.ok && h && h.asked === S.values.holder) {
    text += h.cable > 0
      ? ` <b>${mm(h.cable)} mm</b> straight behind it is kept empty for the cables (dashed in the view).`
      : ` No room is kept behind it for cables: Cable room is 0.`;
  }
  el.className = support.ok && h && h.asked === S.values.holder && h.cable === 0 ? "state warn" : "state";
  el.innerHTML = text;
}

/** Set several controls at once (assistant, reset). Returns what actually changed. */
function applyValues(patch, { mark = false } = {}) {
  const changed = [];
  for (const s of S.schema.sliders) {
    if (!(s.id in patch) || Number(patch[s.id]) === S.values[s.id]) continue;
    changed.push({ label: s.label, from: fmtValue(s, S.values[s.id]), to: fmtValue(s, patch[s.id]), unit: s.unit });
    S.values[s.id] = Number(patch[s.id]);
    $(`s-${s.id}`).value = patch[s.id];
    $(`w-${s.id}`).classList.toggle("is-changed", mark);
    paintSlider(s);
  }
  if (patch.material && patch.material !== S.values.material) {
    const label = (id) => S.schema.materials.find((m) => m.id === id)?.short ?? id;
    changed.push({ label: "Material", from: label(S.values.material), to: label(patch.material), unit: "" });
    S.values.material = patch.material;
    $("material").value = patch.material;
  }
  if (patch.holder && patch.holder !== S.values.holder && S.schema.holders.some((h) => h.id === patch.holder)) {
    const label = (id) => S.schema.holders.find((h) => h.id === id)?.label ?? id;
    changed.push({ label: "Camera held by", from: label(S.values.holder), to: label(patch.holder), unit: "" });
    S.values.holder = patch.holder;
    $("holder").value = patch.holder;
  }
  if (changed.length) { requestGenerate("settle"); scheduleSave(); }
  return changed;
}

/* ── Variations ───────────────────────────────────────────────────────────────
   Several designs for one locked camera: a plate against a sleeve, a ring
   against bolted feet. Each keeps its own anchors and values; the scan, the
   camera pose and the arm are shared. Nothing is lost by trying another. */

const MAX_VARIATIONS = 12;
const liveVariation = () => S.variations.find((v) => v.id === S.active) ?? null;
const cloneAnchors = (list) => list.map((a) => ({ ...a, p: a.p.slice(), n: a.n.slice() }));

/** Values as saved, completed for controls that did not exist when they were:
    those take what the structure was drawn with then, not today's default. */
function completeValues(values = {}) {
  const out = {};
  for (const s of S.schema.sliders) {
    const v = Number(values[s.id]);
    out[s.id] = values[s.id] != null && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : (s.legacy ?? s.default);
  }
  out.material = S.schema.materials.some((m) => m.id === values.material) ? values.material : S.schema.defaultMaterial;
  out.holder = S.schema.holders.some((h) => h.id === values.holder) ? values.holder : S.schema.legacyHolder;
  return out;
}

/** Write the working copy back into the active variation. */
function commitVariation() {
  const v = liveVariation();
  if (!v) return;
  v.values = { ...S.values };
  v.anchors = cloneAnchors(S.anchors);
}

function renderVariations() {
  const list = $("variants");
  if (!list) return;
  const only = S.variations.length === 1;
  const sum = (v) => {
    // The one on screen is described as it stands now, not as last put away.
    const on = v.id === S.active;
    const values = on ? S.values : v.values, anchors = (on ? S.anchors : v.anchors) ?? [];
    const holder = S.schema.holders.find((h) => h.id === values?.holder)?.label.split(",")[0] ?? "";
    const base = anchors.some((a) => a.kind === "ring") ? "ring" : anchors.length ? `${anchors.length} anchor${anchors.length > 1 ? "s" : ""}` : "no anchor";
    const m = v.summary;
    const grams = m ? m.mass * 1000 : 0;
    const figures = m ? ` · ${grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams.toFixed(0)} g`} · ${(m.deflection * 1000).toFixed(m.deflection < 1e-4 ? 3 : 2)} mm${m.met ? "" : " (target not met)"}` : "";
    return `${holder.toLowerCase()} · ${base}${figures}`;
  };
  // Typing in the name must not lose the caret to a redraw.
  if (document.activeElement?.id === "var-name" && list.querySelectorAll("li").length === S.variations.length) {
    for (const v of S.variations) { const el = list.querySelector(`[data-sum="${v.id}"]`); if (el) el.textContent = sum(v); }
    return;
  }
  list.innerHTML = S.variations
    .map((v) => {
      const on = v.id === S.active;
      const name = on
        ? `<input type="text" id="var-name" value="${esc(v.name)}" maxlength="40" aria-label="Name of the variation on screen" title="The variation on screen. Type to rename it." />`
        : `<button class="name" data-var-open="${v.id}" title="Show this variation">${esc(v.name)}</button>`;
      const remove = `<button class="x" data-var-remove="${v.id}" ${only ? "disabled" : ""} aria-label="Remove ${esc(v.name)}" title="${only ? "The only variation cannot be removed" : "Remove this variation"}">×</button>`;
      return `<li class="${on ? "is-active" : ""}">${name}${remove}<span class="sum" data-sum="${v.id}">${esc(sum(v))}</span></li>`;
    })
    .join("");
  const full = S.variations.length >= MAX_VARIATIONS;
  $("btn-var-new").disabled = full || !S.pose;
  $("btn-var-new").title = full
    ? `${MAX_VARIATIONS} variations is the limit: remove one first`
    : !S.pose ? "Place the camera first: variations share its pose" : "Keeps the one on screen as it is and continues on a copy";
}

function newVariation(name) {
  if (S.variations.length >= MAX_VARIATIONS) return null;
  commitVariation();
  const from = liveVariation();
  let n = S.variations.length + 1;
  while (S.variations.some((v) => v.id === `v${n}`)) n++;
  let label = name;
  for (let k = S.variations.length + 1; !label; k++) if (!S.variations.some((v) => v.name === `Variation ${k}`)) label = `Variation ${k}`;
  const v = { id: `v${n}`, name: label.slice(0, 40), values: { ...S.values }, anchors: cloneAnchors(S.anchors), summary: from?.summary ?? null };
  S.variations.push(v);
  S.active = v.id;
  renderVariations();
  scheduleSave();
  return v;
}

function openVariation(id) {
  const v = S.variations.find((x) => x.id === id);
  if (!v || id === S.active) return;
  commitVariation();
  setMode(null);
  S.active = id;
  const sameBase = JSON.stringify(v.anchors) === JSON.stringify(S.anchors);
  S.anchors = cloneAnchors(v.anchors);
  if (!sameBase) {
    // The obstacle map is for the other variation's anchors: nothing is drawn
    // until it has been rebuilt for these.
    S.sceneReady = false;
    S.result = null;
    part.visible = false;
    skeleton.visible = false;
    camCable.visible = false;
  }
  applyValues(completeValues(v.values));
  for (const s of S.schema.sliders) $(`w-${s.id}`).classList.remove("is-changed");
  $("ask-reply").innerHTML = "";
  renderAll();
  if (!sameBase) scheduleScene();
}

function removeVariation(id) {
  if (S.variations.length <= 1) return;
  const i = S.variations.findIndex((v) => v.id === id);
  if (i < 0) return;
  if (id === S.active) openVariation(S.variations[i === 0 ? 1 : i - 1].id);
  S.variations.splice(S.variations.findIndex((v) => v.id === id), 1);
  renderVariations();
  scheduleSave();
}

function renameVariation(name) {
  const v = liveVariation();
  const clean = String(name).replace(/\s+/g, " ").trim().slice(0, 40);
  if (!v || !clean || clean === v.name) return;
  v.name = clean;
  scheduleSave();
}

/* ── Assistant ────────────────────────────────────────────────────────────── */

/** Solver metrics in the units and names the assistant is told about. */
function brief(m) {
  if (!m || m.error) return { error: m?.error ?? "no result" };
  return {
    deflection_mm: +(m.deflection * 1000).toFixed(4), target_mm: +(m.target * 1000).toFixed(4), met: m.met,
    tilt_mrad: +(m.tilt * 1000).toFixed(3), first_mode_hz: Math.round(m.frequency), mass_g: Math.round(m.mass * 1000),
    clearance_to_scan_mm: m.clearanceScan == null ? null : Math.round(m.clearanceScan * 1000),
    clearance_to_view_mm: m.clearanceView == null ? null : Math.round(m.clearanceView * 1000),
    feet: m.feet, struts: m.struts,
  };
}

/** Limits the engineer stated, checked against a measured result. */
const LIMITS = [
  { id: "max_deflection_mm", key: "deflection_mm", over: true, name: "deflection", unit: "mm" },
  { id: "max_mass_g", key: "mass_g", over: true, name: "mass", unit: "g" },
  { id: "max_tilt_mrad", key: "tilt_mrad", over: true, name: "tilt", unit: "mrad" },
  { id: "min_first_mode_hz", key: "first_mode_hz", over: false, name: "first mode", unit: "Hz" },
];
function missedLimits(limits, measured, before) {
  if (measured.error) return [`the solver could not build it: ${measured.error}`];
  const out = [];
  for (const l of LIMITS) {
    const limit = limits?.[l.id];
    if (!Number.isFinite(limit)) continue;
    const v = measured[l.key];
    // 1% grace: the limit is a typed round number, the solver's is not.
    if (l.over ? v > limit * 1.01 : v < limit * 0.99) out.push(`${l.name} ${v} ${l.unit}, asked ${l.over ? "at most" : "at least"} ${limit} ${l.unit}`);
  }
  if (before.met && !measured.met) out.push(`rigidity target no longer met (${measured.deflection_mm} mm against a target of ${measured.target_mm} mm)`);
  return out;
}

/**
 * The assistant proposes; the solver measures; only then do the sliders move.
 * A proposal that misses a limit the engineer stated goes back with its
 * measured result, up to two times.
 */
async function ask() {
  const text = $("ask-text").value.trim();
  if (text.length < 2 || !S.sceneReady) return;
  const state = $("ask-state");
  state.className = "state";
  state.textContent = "measuring…";
  $("btn-ask").disabled = true;
  const previous = { ...S.values };
  try {
    // Measured, not guessed: the current design in each material.
    const settled = S.result?.quality === "settle" && !genBusy && !genPending && !settleTimer;
    const mats = S.schema.materials.map((m) => m.id).filter((id) => !settled || id !== S.values.material);
    const probed = (await call("probe", { candidates: mats.map((id) => ({ ...S.values, material: id })) })).results;
    const byMaterial = Object.fromEntries(mats.map((id, i) => [id, brief(probed[i])]));
    if (settled) byMaterial[S.values.material] = brief(S.result.metrics);
    const before = byMaterial[S.values.material];
    const trials = [];
    let data = null, measured = null, missed = [];
    for (let round = 0; round < 3; round++) {
      state.textContent = round ? `revising · attempt ${round + 1} of 3…` : "asking…";
      const res = await fetch("/api/fixture/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: text,
          values: S.values,
          lang: window.Platform.getLang(),
          metrics: before,
          whatIf: { same_settings_in_each_material: byMaterial },
          trials,
          context: {
            anchors: S.anchors.length,
            camera_mass_g: Math.round(camSpec().mass * 1000),
            camera_to_furthest_foot_mm: Math.round((S.result?.metrics.reach ?? 0) * 1000),
          },
        }),
      });
      data = await res.json().catch(() => ({ ok: false, error: "the server did not answer" }));
      if (!data.ok) throw new Error(data.error);
      // A cradle or sleeve needs a drawn camera body; without one it is not offered.
      if (data.holder && !holderSupport().ok) data.holder = undefined;
      if (!Object.keys(data.set).length && !data.material && !data.holder) { measured = null; missed = []; break; }
      state.textContent = "checking with the solver…";
      const candidate = { ...S.values, ...data.set, ...(data.material ? { material: data.material } : {}), ...(data.holder ? { holder: data.holder } : {}) };
      measured = brief((await call("probe", { candidates: [candidate] })).results[0]);
      missed = missedLimits(data.limits, measured, before);
      trials.push({ set: data.set, material: data.material ?? S.values.material, holder: data.holder ?? S.values.holder, measured, missed });
      if (!missed.length) break;
    }

    const unbuildable = measured?.error;
    const changed = unbuildable ? [] : applyValues({ ...data.set, material: data.material, holder: data.holder }, { mark: true });
    state.textContent = "";
    const kg = (g) => `${(g / 1000).toFixed(2)} kg`;
    const check = !measured || unbuildable ? "" : `<div class="diff check">
        <span><i>Solver check${trials.length > 1 ? ` · attempt ${trials.length}` : ""}</i></span>
        <span>Mass <i>${kg(before.mass_g)} →</i> ${kg(measured.mass_g)}</span>
        <span>Deflection at 1 g <i>${before.deflection_mm.toFixed(2)} →</i> ${measured.deflection_mm.toFixed(2)} <i>mm</i></span>
        <span>First mode <i>${before.first_mode_hz} →</i> ${measured.first_mode_hz} <i>Hz</i></span>
      </div>`;
    const warn = missed.length ? `<div class="diff miss">${missed.map((t) => `<span>◆ ${esc(t)}</span>`).join("")}</div>` : "";
    $("ask-reply").innerHTML = `<div class="reply">${esc(data.why || (changed.length ? "Adjusted." : "Nothing to change."))}
      ${changed.length ? `<div class="diff">${changed.map((c) => `<span>${esc(c.label)} <i>${esc(c.from)} →</i> ${esc(c.to)}${c.unit ? ` <i>${esc(c.unit)}</i>` : ""}</span>`).join("")}</div>` : `<div class="diff"><i>No controls changed.</i></div>`}
      ${check}${warn}
      ${changed.length ? `<button class="btn" id="btn-undo">Undo</button>` : ""}
    </div>`;
    $("btn-undo")?.addEventListener("click", () => {
      applyValues(previous);
      $("ask-reply").innerHTML = "";
    });
  } catch (err) {
    state.className = "state err";
    state.textContent = err.message;
  } finally {
    $("btn-ask").disabled = !S.caps?.assist?.available;
  }
}

/* ── Export ───────────────────────────────────────────────────────────────── */

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
/** File name stem: the variation's name, so two exports are told apart. */
const exportStem = () => {
  const slug = (liveVariation()?.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `camera-support${slug ? `-${slug}` : ""}-${stamp()}`;
};

/** Header written into the OBJ so the file says what it is on its own. */
function provenance() {
  const c = S.pose.center.map((v) => (v * 1000).toFixed(1));
  const lines = [
    `generated ${new Date().toISOString()} by the Comer platform camera-support tool`,
    `scan: ${S.scan.name}${S.scan.sample ? " (SAMPLE DATA, not a real station)" : ""}`,
    `camera centre (scan frame, mm): ${c.join(" ")}`,
    `camera view direction: ${S.pose.view.map((v) => v.toFixed(5)).join(" ")}`,
    `camera up direction: ${S.pose.up.map((v) => v.toFixed(5)).join(" ")}`,
    `variation: ${liveVariation()?.name ?? "-"}`,
    `anchors: ${S.anchors.length}`,
    `controls: ${S.schema.sliders.map((s) => `${s.id}=${S.values[s.id]}`).join(" ")} material=${S.values.material} holder=${S.result?.metrics.holder?.style ?? S.values.holder}`,
    "deflection and frequency figures are beam-model estimates; verify before manufacture",
  ];
  return lines;
}

async function exportObj() {
  if (!S.sceneReady) return;
  const box = $("ex-obj"), state = $("obj-state");
  box.dataset.busy = "";
  $("btn-obj").disabled = true;
  state.className = "state";
  state.textContent = "Meshing at 1 mm…";
  try {
    const r = await call("obj", { values: { ...S.values }, name: "camera support", lines: provenance() });
    const name = `${exportStem()}.obj`;
    download(r.blob, name);
    state.innerHTML = `<b>${name}</b><br>${r.metrics.triangles.toLocaleString("en-US")} triangles · ${mb(r.blob.size)} · millimetres · one closed body${r.metrics.pieces > 1 ? ` — <span class="state warn">but in ${r.metrics.pieces} pieces</span>` : ""}`;
  } catch (err) {
    state.className = "state err";
    state.textContent = `Export failed: ${err.message}`;
  } finally {
    delete box.dataset.busy;
    $("btn-obj").disabled = false;
  }
}

async function exportStep() {
  if (!S.sceneReady || !S.caps?.step?.available) return;
  const box = $("ex-step"), state = $("step-state");
  box.dataset.busy = "";
  $("btn-step").disabled = true;
  state.className = "state";
  const t0 = performance.now();
  const tick = setInterval(() => {
    state.textContent = `CAD kernel building the solid — ${Math.round((performance.now() - t0) / 1000)} s (usually 15 to 45)`;
  }, 1000);
  state.textContent = "CAD kernel building the solid…";
  try {
    // Same sizing pass the OBJ uses, so both files are the same structure.
    const r = await call("generate", { values: { ...S.values }, quality: "settle" });
    const res = await fetch("/api/fixture/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "camera-support", solid: r.solid }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `the server answered ${res.status}`);
    }
    const report = JSON.parse(res.headers.get("X-Fixture-Report") || "{}");
    const blob = await res.blob();
    const name = `${exportStem()}.step`;
    download(blob, name);
    const meshVol = r.metrics.volume * 1e9;
    const diff = meshVol > 0 ? ((report.volumeMm3 - meshVol) / meshVol) * 100 : 0;
    state.innerHTML =
      `<b>${name}</b><br>${report.solids} solid · ${report.members} members · ${report.holes} bolt holes · ${mb(blob.size)} · ${(report.ms / 1000).toFixed(0)} s` +
      `<br>Volume ${(report.volumeMm3 / 1000).toFixed(0)} cm³, ${Math.abs(diff).toFixed(1)}% ${diff < 0 ? "less" : "more"} than the mesh — the blends are the difference.` +
      (report.cutFailures || report.fuseFailures ? `<br><span class="state warn">${report.fuseFailures} joins and ${report.cutFailures} cuts were skipped by the kernel — inspect the file.</span>` : "");
  } catch (err) {
    state.className = "state err";
    state.textContent = `Export failed: ${err.message}`;
  } finally {
    clearInterval(tick);
    delete box.dataset.busy;
    $("btn-step").disabled = false;
  }
}

/* ── Render the panels from state ─────────────────────────────────────────── */

function renderAll() {
  const has = Boolean(S.scan);
  $("sec-camera").classList.toggle("is-off", !has);
  $("sec-arm").classList.toggle("is-off", !S.pose);
  $("sec-anchors").classList.toggle("is-off", !S.pose);
  for (const id of ["sec-structure", "sec-assist", "sec-export"]) $(id).classList.toggle("is-off", !S.sceneReady);
  renderCamera();
  renderPoseState();
  renderArmState();
  renderAnchors();
  if (!S.sceneReady) {
    setGenChip(!has ? "waiting" : !S.pose ? "needs a camera pose" : !S.locked ? "pose not locked" : S.anchors.length ? "waiting" : "needs an anchor", "");
  }
  // Say why, where the control is.
  const support = S.schema ? holderSupport() : { ok: true };
  if (S.schema) {
    $("holder").disabled = !support.ok;
    $("holder").title = support.ok ? "" : `Plate only: ${support.reason}.`;
    renderHolderState();
    renderVariations();
    $("sec-variations").classList.toggle("is-off", !S.pose);
    renderLinks();
  }
  const met = {
    ring: S.anchors.some((a) => a.kind === "ring"),
    holder: support.ok && S.values.holder !== "plate",
  };
  const why = {
    ring: "it applies to a ring anchor, and none is set in step 4",
    holder: support.ok ? "it applies to a cradle or sleeve, and the camera is held by a plate" : "it applies to a cradle or sleeve, which this camera cannot have",
  };
  for (const s of S.schema?.sliders ?? []) {
    if (!s.needs) continue;
    $(`s-${s.id}`).disabled = !met[s.needs];
    $(`w-${s.id}`).classList.toggle("is-na", !met[s.needs]);
    $(`w-${s.id}`).title = met[s.needs] ? s.help : `${s.help} Off: ${why[s.needs]}.`;
  }
  const assist = S.caps?.assist;
  $("btn-ask").disabled = !assist?.available || !S.sceneReady;
  if (assist && !assist.available) { $("ask-state").className = "state warn"; $("ask-state").textContent = `Unavailable: ${assist.reason}`; }
  const step = S.caps?.step;
  $("btn-step").disabled = !step?.available || !S.sceneReady;
  if (step && !step.available) { $("step-state").className = "state warn"; $("step-state").textContent = `Unavailable: ${step.reason}`; }
  redraw();
  scheduleSave();
}

function fillCameraSpec(id) {
  const c = S.schema.cameras.find((x) => x.id === id) ?? S.schema.cameras[0];
  [$("cam-l").value, $("cam-w").value, $("cam-h").value] = c.size_mm;
  [$("cam-hu").value, $("cam-hv").value] = c.holes_mm;
  $("cam-mass").value = c.mass_g;
  $("cam-face").value = c.mountFace;
  $("cam-note").textContent = c.note;
  // A camera with a drawing is not editable here: say so on the fields.
  const fixed = Boolean(c.body_mm);
  for (const k of ["cam-l", "cam-w", "cam-h", "cam-hu", "cam-hv", "cam-face"]) {
    const el = $(k);
    el.dataset.title ??= el.title;
    el.disabled = fixed;
    el.title = fixed ? `From the Cognex drawing (${c.source}). Choose Custom to enter your own.` : el.dataset.title;
  }
  const lenses = S.schema.lenses.filter((l) => !c.lenses || c.lenses.includes(l.id));
  $("cam-lens").innerHTML = lenses.map((l) => `<option value="${l.id}">${esc(l.label)} · ${l.fovDeg}° field</option>`).join("");
  const want = c.defaultLens ?? S.schema.defaultLens;
  $("cam-lens").value = lenses.some((l) => l.id === want) ? want : lenses[0].id;
}

/* ── Saved setup ──────────────────────────────────────────────────────────────
   The scan stays on this machine; what was decided about it — camera pose,
   target, anchors, arm corrections, slider values — is a few numbers, kept in
   this browser and on the server so reopening the scan picks up where it
   stopped, from any browser. */

let restoring = false, saveTimer = null;
let lastSaved = ""; // the setup as last written or reopened: nothing to do while it still matches
const setupKey = () => `fixture.setup:${S.scan.name}:${S.scan.count}`;
const scanRef = () => ({ name: S.scan.name, count: S.scan.count });

const anchorsOut = (list) => list.map((a) => ({
  p: a.p, n: a.n, rms: Number.isFinite(a.rms) ? a.rms : null, flat: a.flat, count: a.count,
  ...(a.kind === "ring" ? { kind: "ring", rIn: a.rIn, rOut: a.rOut, coverage: a.coverage } : {}),
}));
const anchorsIn = (list) => (list ?? []).slice(0, 4).map((a) => ({
  p: a.p, n: a.n, rms: a.rms ?? Infinity, flat: Boolean(a.flat), count: a.count ?? 0,
  ...(a.kind === "ring" && a.rOut > 0 ? { kind: "ring", rIn: a.rIn ?? 0, rOut: a.rOut, coverage: a.coverage ?? 1 } : {}),
}));

function snapshot() {
  const n = (id) => Number($(id).value);
  commitVariation();
  return {
    pose: S.pose, target: S.target, locked: S.locked,
    orient: S.scan.orient,
    // The active variation's anchors and values, also at the top level.
    anchors: anchorsOut(S.anchors),
    variations: S.variations.map((v) => ({ id: v.id, name: v.name, values: { ...v.values }, anchors: anchorsOut(v.anchors), summary: v.summary ?? null })),
    active: S.active,
    camera: {
      model: $("cam-model").value, lens: $("cam-lens").value, face: $("cam-face").value,
      l: n("cam-l"), w: n("cam-w"), h: n("cam-h"), hu: n("cam-hu"), hv: n("cam-hv"), mass: n("cam-mass"),
    },
    values: { ...S.values },
    reach: n("reach"),
    brushes: S.brushes,
  };
}

function scheduleSave() {
  if (restoring || !S.setupReady || !S.scan || S.scan.sample || !S.pose) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSetup, 500);
}

/** A setup as compared for "has anything changed": the measured figures kept
    with each variation follow from the rest and are not a change by themselves. */
const fingerprint = (setup) => JSON.stringify({ ...setup, variations: setup.variations.map(({ summary, ...v }) => v) });

let saving = false, saveAgain = false;
async function saveSetup() {
  if (!S.scan || S.scan.sample || !S.pose) return;
  // One write at a time: each has to name the revision the last one made.
  if (saving) { saveAgain = true; return; }
  const setup = snapshot();
  const now = fingerprint(setup);
  if (now === lastSaved) return;
  lastSaved = now;
  saving = true;
  try {
    await writeSetup(setup);
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; scheduleSave(); }
  }
}

async function writeSetup(setup) {
  const savedAt = new Date().toISOString();
  const scan = S.scan;
  let local = false, server = false;
  // The server counts revisions. A write based on a revision it has moved on
  // from is refused, so a tab left open cannot overwrite newer work.
  if (!S.conflict) {
    try {
      const send = (base) => fetch("/api/fixture/setup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan: scanRef(), setup, base }),
      });
      let res = await send(S.rev);
      if (S.scan !== scan) return;
      // A link is the copy that matters. The scan's own copy moving on does
      // not freeze the link: take its new revision and write this one.
      if (res.status === 409 && S.link) {
        try {
          const d = await (await fetch(`/api/fixture/setup?${new URLSearchParams(scanRef())}`)).json();
          S.rev = d.setup?.rev ?? 0;
        } catch { /* keep the revision we had */ }
        res = await send(S.rev);
      }
      if (res.ok) { server = true; S.rev = (await res.json()).rev ?? S.rev; }
      else if (res.status === 409 && !S.link) S.conflict = true;
    } catch { /* offline */ }
    if (S.link && !S.conflict) {
      try {
        // A name being typed for a new link must not rename this one.
        const typed = $("link-name").value.trim();
        const name = typed && slugify(typed) === S.link.slug ? typed : S.link.name;
        const res = await fetch(`/api/fixture/links/${S.link.slug}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, scan: scanRef(), setup, base: S.linkRev }),
        });
        if (S.scan !== scan) return;
        if (res.ok) {
          const d = await res.json();
          server = true;
          S.linkRev = d.rev ?? S.linkRev;
          S.link.name = d.name ?? name;
        } else if (res.status === 409) S.conflict = true;
      } catch { /* offline */ }
    }
  }
  try {
    localStorage.setItem(setupKey(), JSON.stringify({ savedAt, rev: S.rev, ...setup }));
    local = true;
  } catch { /* storage full or blocked */ }
  renderSaveState({ savedAt, local, server, conflict: S.conflict });
}

function renderSaveState(info) {
  const el = $("save-state");
  if (!info) { el.hidden = true; el.innerHTML = ""; return; }
  const at = new Date(info.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = new Date(info.savedAt).toLocaleDateString([], { day: "numeric", month: "short" });
  let text, cls = "state";
  const count = info.variations > 1 ? ` and ${info.variations} variations` : "";
  if (info.conflict) {
    text = S.link
      ? "Not saved to the link: it was changed somewhere else after this page opened it. What you change here stays in this page only."
      : "Not saved to the server: this setup was changed in another tab or session after this page opened it. What you change here stays in this page only.";
    cls = "state warn";
  } else if (info.restored) text = `Setup from <b>${esc(day)} ${esc(at)}</b> reopened: camera pose, anchors and slider values${count}.`;
  else if (info.server && info.local) text = `Setup saved <b>${esc(at)}</b> on the server and in this browser.`;
  else if (info.local) { text = `Setup saved <b>${esc(at)}</b> in this browser only: the server did not take it.`; cls = "state warn"; }
  else if (info.server) text = `Setup saved <b>${esc(at)}</b> on the server.`;
  else { text = "Setup not saved: neither this browser nor the server took it."; cls = "state err"; }
  el.className = cls;
  el.hidden = false;
  // On a link, Start over would not stay: opening the link brings it back.
  // The link itself is removed from its own control.
  const action = info.conflict
    ? `<button class="btn" id="btn-reload-setup" style="margin-top:8px" title="Drops what was changed in this page since, and shows the version on the server">Load the newer version</button>`
    : S.link ? ""
      : `<button class="btn" id="btn-forget" style="margin-top:8px" title="Deletes the saved pose, anchors and every variation for this scan">Start over</button>`;
  el.innerHTML = `${text}${action ? `<br>${action}` : ""}`;
  $("btn-forget")?.addEventListener("click", forgetSetup);
  $("btn-reload-setup")?.addEventListener("click", () => {
    try { localStorage.removeItem(setupKey()); } catch { /* nothing stored */ }
    reloadNewer();
  });
}

/** The server's copy of what this page is editing: the link, when this page
 *  is one, otherwise the scan's own saved setup. */
async function reloadNewer() {
  const slug = S.link?.slug || S.linkPending?.slug;
  if (slug) {
    try {
      const d = await (await fetch(`/api/fixture/links/${slug}`)).json();
      if (d.ok) S.linkPending = d.link;
    } catch { /* setScan below reopens whatever this page already has */ }
    S.conflict = false;
  }
  setScan(S.scan, S.scan.name);
}

async function forgetSetup() {
  clearTimeout(saveTimer);
  try { localStorage.removeItem(setupKey()); } catch { /* nothing stored */ }
  try { await fetch(`/api/fixture/setup?${new URLSearchParams(scanRef())}`, { method: "DELETE" }); } catch { /* offline */ }
  setScan(S.scan, S.scan.name);
}

async function restoreSetup() {
  const scan = S.scan;
  S.linkWrong = null;
  S.linkCountWarn = 0;
  const pending = S.linkPending;
  if (pending?.setup && S.scan.name.toLowerCase() === pending.scan.name.toLowerCase()) {
    S.link = { slug: pending.slug, name: pending.name };
    S.linkRev = pending.rev ?? 0;
    try {
      await applySetup({ ...pending.setup, savedAt: pending.savedAt, rev: pending.rev ?? 0 });
      if (S.scan !== scan) return;
      // applySetup kept the link's revision. The scan's own copy counts its
      // own, and gets this one written over it when the two differ.
      S.linkRev = pending.rev ?? 0;
      let scanRev = 0, same = false;
      try {
        const d = await (await fetch(`/api/fixture/setup?${new URLSearchParams(scanRef())}`)).json();
        if (d.ok && d.setup) {
          scanRev = d.setup.rev ?? 0;
          const rest = { ...d.setup };
          delete rest.savedAt;
          delete rest.rev;
          same = fingerprint(snapshot()) === fingerprint(rest);
        }
      } catch { /* offline: the link is already on screen */ }
      if (S.scan !== scan) return;
      S.rev = scanRev;
      S.linkCountWarn = S.scan.count === pending.scan.count ? 0 : pending.scan.count;
      if (!same) await mirrorScan(snapshot());
      renderLinks();
    } finally {
      if (S.scan === scan) S.setupReady = true;
    }
    return;
  }
  if (pending?.scan) {
    // A different file: nothing from the link is applied, and nothing typed
    // here is written back to it.
    S.link = null;
    S.linkWrong = pending.scan;
    renderLinks();
  }
  let best = null;
  try {
    const raw = localStorage.getItem(setupKey());
    if (raw) best = JSON.parse(raw);
  } catch { /* unreadable: ignore */ }
  let fromHere = Boolean(best);
  try {
    const d = await (await fetch(`/api/fixture/setup?${new URLSearchParams(scanRef())}`)).json();
    if (d.ok && d.setup) {
      const theirs = d.setup.rev ?? 0, later = String(d.setup.savedAt) > String(best?.savedAt);
      // The server's copy, unless this browser's is a later edit of the same
      // revision: work done here that the server did not take. A copy kept
      // before revisions were counted carries none and goes by the clock.
      const serverWins = !best || (best.rev == null ? later : theirs > best.rev || (theirs === best.rev && later));
      if (serverWins) { best = d.setup; fromHere = false; }
      else if (best.rev == null && Array.isArray(d.setup.variations)) best = adoptStray(d.setup, best);
      else if (best.rev == null) best.rev = theirs;
    }
  } catch { /* offline: the browser's copy will do */ }
  if (S.scan !== scan) return; // another scan was opened meanwhile
  try {
    if (best?.pose) await applySetup(best);
  } finally {
    if (S.scan === scan) S.setupReady = true;
  }
  // What only this browser had goes to the server now, not at the next change.
  if (S.scan === scan && best?.pose && fromHere) { lastSaved = ""; scheduleSave(); }
}

/**
 * This browser holds a design from a page that knew nothing of variations,
 * changed after the server's copy gained some. Neither is dropped: the
 * server's setup is taken, and the design from here joins it as one more
 * variation, unless it is one of them already or there is no room.
 */
function adoptStray(server, stray) {
  const same = (v) =>
    JSON.stringify(completeValues(v.values)) === JSON.stringify(completeValues(stray.values)) &&
    JSON.stringify(anchorsIn(v.anchors)) === JSON.stringify(anchorsIn(stray.anchors));
  if (server.variations.some(same) || server.variations.length >= MAX_VARIATIONS) return server;
  let n = server.variations.length + 1;
  while (server.variations.some((v) => v.id === `v${n}`)) n++;
  const at = new Date(stray.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const v = { id: `v${n}`, name: `From this browser ${at}`.slice(0, 40), values: stray.values, anchors: stray.anchors ?? [], summary: null };
  return { ...server, variations: [...server.variations, v], active: v.id };
}

async function applySetup(s) {
  restoring = true;
  try {
    if (s.orient && s.orient !== S.scan.orient) {
      // Saved after the scan was turned over by hand: turn it the same way.
      await turnScan();
    } else if (!s.orient && S.scan.orient.endsWith("-")) {
      // Saved before the tool recorded which way up the scan was, when it
      // always took the file's vertical axis as pointing up.
      s = turnSetup(s);
    }
    const cam = s.camera ?? {};
    const model = S.schema.cameras.find((c) => c.id === cam.model);
    if (model) {
      $("cam-model").value = model.id;
      fillCameraSpec(model.id);
      if ([...$("cam-lens").options].some((o) => o.value === cam.lens)) $("cam-lens").value = cam.lens;
      if (!model.body_mm) {
        for (const [id, v] of [["cam-l", cam.l], ["cam-w", cam.w], ["cam-h", cam.h], ["cam-hu", cam.hu], ["cam-hv", cam.hv]]) if (Number.isFinite(v)) $(id).value = v;
        if (S.schema.mountFaces.includes(cam.face)) $("cam-face").value = cam.face;
      }
      if (Number.isFinite(cam.mass)) $("cam-mass").value = cam.mass;
    }
    if (Number.isFinite(s.reach)) {
      $("reach").value = s.reach;
      $("reach").dispatchEvent(new Event("input"));
    }
    S.target = Array.isArray(s.target) ? s.target : null;
    S.rev = Number.isInteger(s.rev) ? s.rev : 0;
    // A setup saved before variations existed is one variation.
    const saved = Array.isArray(s.variations) && s.variations.length ? s.variations : [{ id: "v1", name: "Variation 1", values: s.values, anchors: s.anchors }];
    S.variations = saved.slice(0, MAX_VARIATIONS).map((v, i) => ({
      id: typeof v.id === "string" && v.id ? v.id : `v${i + 1}`,
      name: typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 40) : `Variation ${i + 1}`,
      values: completeValues(v.values), anchors: anchorsIn(v.anchors), summary: v.summary ?? null,
    }));
    S.active = S.variations.some((v) => v.id === s.active) ? s.active : S.variations[0].id;
    S.anchors = cloneAnchors(liveVariation().anchors);
    setPose(s.pose.center, s.pose.view, s.pose.up);
    S.locked = Boolean(s.locked);
    applyValues(liveVariation().values);
    await findArm();
    for (const stroke of s.brushes ?? []) {
      S.brushes.push(stroke);
      adoptMask(await call("brush", stroke));
    }
    renderAll();
    frame();
    scheduleScene();
    lastSaved = fingerprint(snapshot());
    renderSaveState({ savedAt: s.savedAt ?? new Date().toISOString(), restored: true, variations: S.variations.length });
  } finally {
    restoring = false;
  }
}

function applySampleSetup() {
  const t = S.scan?.truth;
  if (!t) return;
  S.target = t.camera.target.slice();
  setPose(t.camera.center, V.sub(t.camera.target, t.camera.center));
  S.anchors = [{ p: t.anchors[0].p.slice(), n: t.anchors[0].n.slice(), rms: 0.003, flat: true, count: 0 }];
  S.locked = true;
  setGizmo(null);
  renderAll();
  frame();
  findArm(); // schedules the scene once the mask is in
}

/** The scan's own saved copy, written to match the link. A refusal leaves the
 *  link on screen and the scan's copy as it was. */
async function mirrorScan(setup) {
  const scan = S.scan;
  const send = (base) => fetch("/api/fixture/setup", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan: scanRef(), setup, base }),
  });
  try {
    let res = await send(S.rev);
    if (S.scan !== scan) return;
    if (res.status === 409) {
      const d = await (await fetch(`/api/fixture/setup?${new URLSearchParams(scanRef())}`)).json();
      S.rev = d.setup?.rev ?? 0;
      res = await send(S.rev);
    }
    if (res.ok && S.scan === scan) S.rev = (await res.json()).rev ?? S.rev;
  } catch { /* the link itself is already loaded */ }
}

/** The address form of a name. The server folds a name the same way. */
function slugify(name) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

const linkSlug = () => S.link?.slug || S.linkPending?.slug || "";

const EMPTY_COPY = "Open a station scan to begin. The camera stays exactly where it was scanned; the tool removes the temporary arm and grows a permanent support under it that you shape with sliders.";

function renderLinkPrompt() {
  const pending = !S.scan && S.linkPending?.scan;
  const title = $("empty-title");
  const lead = $("empty-copy");
  if (title && lead) {
    if (pending) {
      const n = S.linkPending.setup?.variations?.length || 1;
      const variations = n === 1 ? "One variation is in this link." : `${n} variations are in this link.`;
      title.textContent = S.linkPending.name;
      lead.innerHTML = `Open <b>${esc(S.linkPending.scan.name)}</b> (${fmtCount(S.linkPending.scan.count)} points). ${variations} The scan is read in this browser and is not uploaded.`;
    } else if (!S.scan && S.linkMissing) {
      title.textContent = "Camera support";
      lead.textContent = "No configuration at this link. It may have been deleted.";
    } else if (!S.scan) {
      title.textContent = "Camera support";
      lead.textContent = EMPTY_COPY;
    }
  }
  // A shared link is for one file. The sample scan cannot be that file.
  for (const id of ["btn-sample", "btn-sample-2"]) {
    const b = $(id);
    if (b) b.hidden = Boolean(pending);
  }
  if (S.scan) return;
  const el = $("scan-state");
  if (pending) {
    const n = S.linkPending.setup?.variations?.length || 1;
    el.className = "state";
    const variations = n === 1 ? "One variation comes" : `${n} variations come`;
    el.innerHTML = `<b>${esc(S.linkPending.name)}</b><br>Open <b>${esc(S.linkPending.scan.name)}</b> (${fmtCount(S.linkPending.scan.count)} points). ${variations} with the link. The scan is read in this browser and is not uploaded.`;
  } else if (S.linkMissing) {
    el.className = "state err";
    el.innerHTML = `No configuration at this link. It may have been deleted.`;
  }
}

function renderLinks() {
  const nameEl = $("link-name");
  if (!nameEl) return;
  const current = linkSlug();
  const typed = slugify(nameEl.value.trim());
  const same = Boolean(current) && typed === current;
  const save = $("btn-link-save");
  save.hidden = same;
  let why = "";
  if (!S.scan) why = "Open a scan first";
  else if (S.scan.sample) why = "The sample scan is not a file anyone else can open";
  else if (!S.pose) why = "Place the camera first: a link saves its pose and the variations";
  else if (!typed) why = "Name it with letters or numbers";
  save.disabled = Boolean(why);
  save.title = why || "Saves this setup under the name and opens its link";
  $("btn-link-copy").hidden = !current;
  $("btn-link-delete").hidden = !current;
  const url = $("link-url");
  url.hidden = !current;
  if (current) url.value = `${location.origin}/fixture/${current}`;
  const note = S.linkNote
    ?? (S.linkWrong && S.scan ? { cls: "state warn", html: `This file is <b>${esc(S.scan.name)}</b>. The link is for <b>${esc(S.linkWrong.name)}</b> (${fmtCount(S.linkWrong.count)} points), so nothing from it was applied.` }
      : S.link && S.linkCountWarn ? { cls: "state warn", html: `This file has ${fmtCount(S.scan.count)} points; the link was saved with ${fmtCount(S.linkCountWarn)}. The pose is applied — check the camera still sits on the scan.` }
        : current && !S.scan ? { cls: "state", html: "Open the scan file named above. The camera pose and the variations are in this link, and changes update it." }
          : current ? { cls: "state", html: "Changes here update this link. The scan file is not part of it, so send the .ply with the link." }
            : { cls: "state", html: "A link opens this setup after sign-in. The scan file stays on disk." });
  const state = $("link-state");
  state.className = note.cls;
  state.innerHTML = note.html;
  const list = $("link-list");
  $("link-saved").hidden = S.links.length === 0;
  list.innerHTML = S.links.map((l) => {
    const on = l.slug === current;
    const when = new Date(l.savedAt).toLocaleDateString([], { day: "numeric", month: "short" });
    const what = l.variations?.length ? l.variations.join(" · ") : "one design";
    return `<button class="btn" data-link="${esc(l.slug)}" ${on ? "disabled" : ""} title="${on ? "This page" : `${esc(what)} · ${esc(when)}. Opens the link; the scan file is opened again afterwards.`}">${esc(l.name)}</button>`;
  }).join("");
  renderLinkPrompt();
}

async function refreshLinkList() {
  try {
    const d = await (await fetch("/api/fixture/links")).json();
    S.links = d.links ?? [];
  } catch {
    S.links = S.links ?? [];
  }
  renderLinks();
}

async function publishLink() {
  const name = $("link-name").value.trim();
  if (!S.scan || S.scan.sample || !S.pose || !slugify(name)) return;
  S.linkNote = null;
  $("btn-link-save").disabled = true;
  try {
    const setup = snapshot();
    const res = await fetch("/api/fixture/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scan: scanRef(), setup }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.slug) {
      S.linkNote = { cls: "state warn", html: `${esc(data.error || "A configuration with this name already exists.")} <button class="btn" data-link="${esc(data.slug)}" style="margin-top:8px">Open it</button>` };
      return;
    }
    if (!res.ok || !data.slug) {
      S.linkNote = { cls: "state err", html: esc(data.error || "The link was not saved.") };
      return;
    }
    S.link = { slug: data.slug, name: data.name };
    S.linkRev = data.rev ?? 1;
    S.linkPending = { slug: data.slug, name: data.name, rev: S.linkRev, savedAt: data.savedAt, scan: scanRef(), setup };
    S.linkMissing = "";
    S.linkWrong = null;
    history.pushState({ slug: data.slug }, "", data.path);
    $("link-name").value = data.name;
    delete $("link-name").dataset.edited;
    await refreshLinkList();
  } catch {
    S.linkNote = { cls: "state err", html: "The server could not be reached. The link was not saved." };
  } finally {
    renderLinks();
  }
}

async function copyLink() {
  const slug = linkSlug();
  if (!slug) return;
  const url = `${location.origin}/fixture/${slug}`;
  try {
    await navigator.clipboard.writeText(url);
    S.linkNote = { cls: "state ok", html: "Copied." };
  } catch {
    $("link-url").focus();
    $("link-url").select();
    S.linkNote = { cls: "state", html: "Select the address and copy it." };
  }
  renderLinks();
}

async function deleteLink() {
  const slug = linkSlug();
  if (!slug) return;
  const res = await fetch(`/api/fixture/links/${slug}`, { method: "DELETE" });
  if (!res.ok) {
    S.linkNote = { cls: "state err", html: "The link was not deleted." };
    renderLinks();
    return;
  }
  location.replace("/fixture/");
}

/** The slug in /fixture/<slug>, or "" on the plain tool. */
function linkSlugFromPath() {
  const rest = decodeURIComponent(location.pathname).replace(/^\/fixture\/?/, "").replace(/\/$/, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rest) ? rest : "";
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

async function boot() {
  S.schema = await (await fetch("/shared-data/fixture-params.json", { cache: "no-store" })).json();
  await call("init", { schema: S.schema });
  buildSliders();

  $("cam-model").innerHTML = S.schema.cameras.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("");
  $("cam-face").innerHTML = S.schema.mountFaces.map((f) => `<option value="${f}">${f[0].toUpperCase()}${f.slice(1)}</option>`).join("");
  fillCameraSpec(S.schema.cameras[0].id);
  $("cam-model").addEventListener("change", (e) => { fillCameraSpec(e.target.value); renderCamera(); scheduleScene(); scheduleSave(); });
  for (const id of ["cam-lens", "cam-face", "cam-l", "cam-w", "cam-h", "cam-hu", "cam-hv", "cam-mass"]) {
    $(id).addEventListener("change", () => { renderCamera(); scheduleScene(); scheduleSave(); });
  }

  $("file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
  $("btn-sample").addEventListener("click", loadSample);
  $("btn-sample-2").addEventListener("click", loadSample);
  view.addEventListener("dragover", (e) => { e.preventDefault(); view.classList.add("is-drop"); });
  view.addEventListener("dragleave", () => view.classList.remove("is-drop"));
  view.addEventListener("drop", (e) => {
    e.preventDefault();
    view.classList.remove("is-drop");
    const f = [...e.dataTransfer.files].find((x) => /\.ply$/i.test(x.name));
    if (f) loadFile(f);
  });

  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  document.querySelectorAll("[data-gizmo]").forEach((b) => b.addEventListener("click", () => { setMode(null); setGizmo(b.dataset.gizmo); }));
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") { setMode(null); setGizmo(null); } });
  $("btn-lock").addEventListener("click", toggleLock);
  $("btn-locate").addEventListener("click", autoLocate);

  const reach = $("reach");
  const paintReach = () => {
    reach.style.setProperty("--fill", `${((reach.value - reach.min) / (reach.max - reach.min)) * 100}%`);
    $("reach-val").innerHTML = `${Number(reach.value).toFixed(1)}<span class="u">m</span>`;
  };
  paintReach();
  reach.addEventListener("input", paintReach);
  reach.addEventListener("change", findArm);
  $("btn-arm-reset").addEventListener("click", findArm);

  $("anchor-list").addEventListener("click", (e) => {
    const i = e.target.dataset?.remove;
    if (i == null) return;
    S.anchors.splice(Number(i), 1);
    renderAll();
    scheduleScene();
  });

  $("t-scan").addEventListener("change", (e) => { points.visible = e.target.checked && Boolean(S.scan); redraw(); });
  $("t-arm").addEventListener("change", paintPoints);
  $("t-cone").addEventListener("change", (e) => { camCone.visible = e.target.checked; redraw(); });
  $("t-skel").addEventListener("change", (e) => { skeleton.visible = e.target.checked && Boolean(S.result); redraw(); });
  $("btn-frame").addEventListener("click", frame);

  $("btn-var-new").addEventListener("click", () => newVariation());
  $("variants").addEventListener("click", (e) => {
    const open = e.target.dataset?.varOpen, remove = e.target.dataset?.varRemove;
    if (open) openVariation(open);
    if (!remove) return;
    // Removing is not undone: the first click asks, the second removes.
    if (e.target.dataset.armed) { removeVariation(remove); return; }
    e.target.dataset.armed = "1";
    e.target.textContent = "remove?";
    setTimeout(() => { if (e.target.isConnected) { delete e.target.dataset.armed; e.target.textContent = "×"; } }, 3000);
  });
  $("variants").addEventListener("input", (e) => { if (e.target.id === "var-name") renameVariation(e.target.value); });
  $("variants").addEventListener("change", (e) => { if (e.target.id === "var-name") { if (!e.target.value.trim()) e.target.value = liveVariation()?.name ?? ""; } });

  $("btn-reset").addEventListener("click", () => {
    applyValues({ ...Object.fromEntries(S.schema.sliders.map((s) => [s.id, s.default])), material: S.schema.defaultMaterial });
    $("ask-reply").innerHTML = "";
  });
  $("btn-ask").addEventListener("click", ask);
  $("ask-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); });
  $("btn-obj").addEventListener("click", exportObj);
  $("btn-step").addEventListener("click", exportStep);

  const asked = linkSlugFromPath();
  if (asked) {
    try {
      const d = await (await fetch(`/api/fixture/links/${asked}`)).json();
      if (d.ok && d.link) {
        S.linkPending = d.link;
        $("link-name").value = d.link.name;
      } else S.linkMissing = asked;
    } catch {
      S.linkMissing = asked;
    }
  }
  $("btn-link-save").addEventListener("click", publishLink);
  $("btn-link-copy").addEventListener("click", copyLink);
  $("btn-link-delete").addEventListener("click", (e) => {
    // Deleting is not undone: the first click asks, the second deletes.
    if (e.target.dataset.armed) { deleteLink(); return; }
    e.target.dataset.armed = "1";
    e.target.textContent = "delete?";
    setTimeout(() => { if (e.target.isConnected) { delete e.target.dataset.armed; e.target.textContent = "Delete link"; } }, 3000);
  });
  $("links").addEventListener("click", (e) => {
    const slug = e.target.dataset?.link;
    if (slug) location.assign(`/fixture/${slug}`);
  });
  $("link-name").addEventListener("input", () => {
    $("link-name").dataset.edited = "1";
    if (S.linkNote) S.linkNote = null;
    renderLinks();
  });
  $("link-name").addEventListener("change", () => {
    const name = $("link-name").value.trim();
    if (!name) {
      $("link-name").value = S.link?.name || S.linkPending?.name || "";
      delete $("link-name").dataset.edited;
      renderLinks();
      return;
    }
    // The same link, renamed. A different name is a new link, made by the button.
    if (S.link && name !== S.link.name && slugify(name) === S.link.slug) { lastSaved = ""; scheduleSave(); }
  });
  window.addEventListener("popstate", () => location.reload());
  await refreshLinkList();

  applyTheme();
  resize();
  renderAll();

  // What the server can do decides which controls are live; ask, do not assume.
  try {
    S.caps = await (await fetch("/api/fixture/capabilities")).json();
  } catch {
    const reason = "the server could not be reached";
    S.caps = { assist: { available: false, reason }, locate: { available: false, reason }, step: { available: false, reason } };
  }
  renderAll();
}

/* Handles for the end-to-end check (tools/check-fixture-page.mjs). */
window.__fixture = {
  S, call, loadSample, applySampleSetup, applyValues, requestGenerate, exportObj, exportStep, frame, cam3, orbit, redraw,
  setPose, handlePick, toggleLock, renderAll, pickAt, saveSetup, flipScan,
  newVariation, openVariation, removeVariation, renameVariation, renderLinks, publishLink,
  /** True when nothing is being generated or waiting to be. */
  idle: () => !genBusy && !genPending && !settleTimer && S.result?.quality === "settle",
};

boot().catch((err) => {
  $("scan-state").innerHTML = `<span class="state err">The tool could not start: ${esc(err.message)}</span>`;
});
