import express from "express";
import cors from "cors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config, stubMode } from "./config.js";
import { specs } from "./services/specs.js";
import { brainChatRouter } from "./routes/brainChat.js";
import { evalRouter } from "./routes/eval.js";
import { specRouter } from "./routes/spec.js";
import { queryRouter } from "./routes/query.js";
import { authRouter } from "./routes/auth.js";
import { kbRouter } from "./routes/kb.js";
import { lineRouter } from "./routes/line.js";
import { worldLabsRouter } from "./routes/worldlabs.js";
import { worldLabsConfigured } from "./services/worldlabs.js";
import {
  EVAL_LAB_PUBLIC,
  LAB_HTML,
  LOGIN_HTML,
  WELCOME_HTML,
  HOME_HTML,
  KNOWLEDGE_HTML,
  SYNTHETIC_POV_HTML,
  SHARED_DIR,
} from "./paths.js";

const app = express();

// CORS: in dev we default to "*". In prod the host (Render) should
// inject ALLOWED_ORIGINS as a comma-separated list of fully-qualified
// origins (e.g. https://comer.theomnia.ai), at which point we lock it
// down. Cross-origin browser requests from anything else are rejected;
// same-origin requests (login + lab + API on one host) always work.
const allow = config.allowedOrigins;
const wildcard = allow.length === 0 || allow.includes("*");
app.use(
  cors({
    origin: wildcard
      ? true
      : (origin, cb) => {
          if (!origin || allow.includes(origin)) return cb(null, true);
          cb(new Error(`Origin not allowed: ${origin}`));
        },
    credentials: false,
  }),
);
app.use(express.json({ limit: "12mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    stubMode,
    procedure: specs.procedure.proceduralActivity.label,
    steps: specs.procedure.keysteps.length,
    hardwareProfiles: Object.keys(specs.hardware.profiles).length,
    strategies: Object.keys(specs.strategies.strategies).length,
    worldLabs: worldLabsConfigured(),
    cors: wildcard ? "wildcard" : allow,
    nodeEnv: process.env.NODE_ENV ?? "development",
  });
});

app.use("/api/spec", specRouter);
app.use("/api/brain/chat", brainChatRouter);
app.use("/api/eval", evalRouter);
app.use("/api/auth", authRouter);
app.use("/api/line", lineRouter);
app.use("/api/kb", kbRouter);
app.use("/api/worldlabs", worldLabsRouter);
app.use("/query", queryRouter); // Rokid APK compatibility

// Dev-only: browser posts calibrated splat capture from localStorage (localhost).
const CAPTURE_DUMP = join(EVAL_LAB_PUBLIC, ".station1_capture.json");
const TOUR_DUMP = join(EVAL_LAB_PUBLIC, ".station_tour_calibration.json");
const MESH_ALIGN_DUMP = join(EVAL_LAB_PUBLIC, "station1-mesh-align.json");

interface StationOperatorPayload {
  scale?: number;
  fwd?: number;
  side?: number;
  lift?: number;
  yaw?: number;
  anchorX?: number;
  anchorZ?: number;
  faceYaw?: number;
  meshFloorY?: number;
  targetHeightM?: number;
  shoulderHalfWidthM?: number;
  clearanceMarginM?: number;
  naturalMaterials?: boolean;
  collisionWithMesh?: boolean;
  groundDebug?: boolean;
}

interface StationMeshAlignPayload {
  show?: boolean;
  uniformScaleMult: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  rotYDeg: number;
  rotY?: number;
  operator?: StationOperatorPayload;
  savedAt?: string;
}

function roundMesh(n: number, digits = 4): number {
  return Number(n.toFixed(digits));
}

function formatStationMeshAlignBlock(a: StationMeshAlignPayload): string {
  return [
    "align: {",
    `              uniformScaleMult: ${roundMesh(a.uniformScaleMult, 4)},`,
    `              offsetX: ${roundMesh(a.offsetX, 4)},`,
    `              offsetY: ${roundMesh(a.offsetY, 4)},`,
    `              offsetZ: ${roundMesh(a.offsetZ, 4)},`,
    `              rotYDeg: ${roundMesh(a.rotYDeg, 2)},`,
    `              show: ${a.show !== false},`,
    "            },",
  ].join("\n");
}

function formatStationOperatorBlock(op: StationOperatorPayload): string {
  const lines = [
    "operator: {",
    `              scale: ${roundMesh(op.scale ?? 0.93, 2)},`,
    `              fwd: ${roundMesh(op.fwd ?? 0.42, 4)},`,
    `              side: ${roundMesh(op.side ?? 0.45, 4)},`,
    `              lift: ${roundMesh(op.lift ?? 0, 4)},`,
    `              yaw: ${roundMesh(op.yaw ?? 0, 2)},`,
  ];
  if (Number.isFinite(op.anchorX)) lines.push(`              anchorX: ${roundMesh(op.anchorX!, 4)},`);
  if (Number.isFinite(op.anchorZ)) lines.push(`              anchorZ: ${roundMesh(op.anchorZ!, 4)},`);
  if (Number.isFinite(op.faceYaw)) lines.push(`              faceYaw: ${roundMesh(op.faceYaw!, 4)},`);
  if (Number.isFinite(op.meshFloorY)) lines.push(`              meshFloorY: ${roundMesh(op.meshFloorY!, 4)},`);
  lines.push(
    `              targetHeightM: ${roundMesh(op.targetHeightM ?? 1.70, 2)},`,
    `              shoulderHalfWidthM: ${roundMesh(op.shoulderHalfWidthM ?? 0.22, 2)},`,
    `              clearanceMarginM: ${roundMesh(op.clearanceMarginM ?? 0.06, 2)},`,
    `              naturalMaterials: ${op.naturalMaterials !== false},`,
    `              collisionWithMesh: ${op.collisionWithMesh === true},`,
    `              groundDebug: ${op.groundDebug === true},`,
    "            },",
  );
  return lines.join("\n");
}

function patchSyntheticPovStationMeshAlign(body: StationMeshAlignPayload): boolean {
  const marker = 'url: "/lab/assets/industrial-machine-shop-mesh.glb"';
  let html = readFileSync(SYNTHETIC_POV_HTML, "utf8");
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) return false;
  const portalIdx = html.indexOf("portalOffsets:", markerIdx);
  if (portalIdx < 0) return false;
  const before = html.slice(0, markerIdx);
  let segment = html.slice(markerIdx, portalIdx);
  const after = html.slice(portalIdx);

  segment = segment.replace(/\s+operator:\s*\{[\s\S]*?\n\s+\},/g, "");
  if (segment.includes("align:")) {
    segment = segment.replace(
      /\s+align:\s*\{[\s\S]*?\n\s+show:\s*[^,\n]+,\s*\n\s+\},/,
      `\n            ${formatStationMeshAlignBlock(body)}`,
    );
  } else {
    segment = segment.replace(
      /(scale:\s*[\d.]+,)\s*$/,
      `$1\n            ${formatStationMeshAlignBlock(body)}`,
    );
  }
  if (body.operator) {
    segment = segment.replace(
      /\s+align:\s*\{[\s\S]*?\n\s+show:\s*[^,\n]+,\s*\n\s+\},/,
      (match) => `${match}\n            ${formatStationOperatorBlock(body.operator!)}`,
    );
  }

  html = before + segment + after;
  writeFileSync(SYNTHETIC_POV_HTML, html);
  return true;
}

function persistStationMeshAlign(body: StationMeshAlignPayload) {
  const payload: StationMeshAlignPayload = {
    show: body.show !== false,
    uniformScaleMult: roundMesh(body.uniformScaleMult, 6),
    offsetX: roundMesh(body.offsetX, 6),
    offsetY: roundMesh(body.offsetY, 6),
    offsetZ: roundMesh(body.offsetZ, 6),
    rotYDeg: roundMesh(body.rotYDeg ?? (body.rotY != null ? body.rotY * 180 / Math.PI : 0), 4),
    savedAt: body.savedAt ?? new Date().toISOString(),
  };
  if (body.operator) {
    const op = body.operator;
    payload.operator = {
      scale: roundMesh(op.scale ?? 0.93, 4),
      fwd: roundMesh(op.fwd ?? 0.42, 4),
      side: roundMesh(op.side ?? 0.45, 4),
      lift: roundMesh(op.lift ?? 0, 4),
      yaw: roundMesh(op.yaw ?? 0, 2),
      targetHeightM: roundMesh(op.targetHeightM ?? 1.70, 2),
      shoulderHalfWidthM: roundMesh(op.shoulderHalfWidthM ?? 0.22, 2),
      clearanceMarginM: roundMesh(op.clearanceMarginM ?? 0.06, 2),
      naturalMaterials: op.naturalMaterials !== false,
      collisionWithMesh: op.collisionWithMesh === true,
      groundDebug: op.groundDebug === true,
    };
    if (Number.isFinite(op.anchorX)) payload.operator.anchorX = roundMesh(op.anchorX!, 4);
    if (Number.isFinite(op.anchorZ)) payload.operator.anchorZ = roundMesh(op.anchorZ!, 4);
    if (Number.isFinite(op.faceYaw)) payload.operator.faceYaw = roundMesh(op.faceYaw!, 4);
    if (Number.isFinite(op.meshFloorY)) payload.operator.meshFloorY = roundMesh(op.meshFloorY!, 4);
  }
  writeFileSync(MESH_ALIGN_DUMP, JSON.stringify(payload, null, 2));
  const patched = patchSyntheticPovStationMeshAlign(payload);
  return { ok: true, path: "station1-mesh-align.json", patchedHtml: patched, operatorSaved: !!payload.operator };
}

app.get("/station1-mesh-align.json", (_req, res) => {
  if (!existsSync(MESH_ALIGN_DUMP)) {
    res.status(404).json({ error: "none" });
    return;
  }
  res.type("json").send(readFileSync(MESH_ALIGN_DUMP, "utf8"));
});

app.post("/api/dev/mesh-align", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  const body = req.body as StationMeshAlignPayload;
  if (!body || !Number.isFinite(body.uniformScaleMult)) {
    res.status(400).json({ error: "invalid mesh align payload" });
    return;
  }
  res.json(persistStationMeshAlign(body));
});
app.get("/api/dev/mesh-align", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  if (!existsSync(MESH_ALIGN_DUMP)) {
    res.status(404).json({ error: "none" });
    return;
  }
  res.type("json").send(readFileSync(MESH_ALIGN_DUMP, "utf8"));
});
app.post("/api/dev/capture-origin", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  writeFileSync(CAPTURE_DUMP, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});
app.get("/api/dev/capture-origin", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  if (!existsSync(CAPTURE_DUMP)) {
    res.status(404).json({ error: "none" });
    return;
  }
  res.type("json").send(readFileSync(CAPTURE_DUMP, "utf8"));
});
app.post("/api/dev/capture-tour", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  writeFileSync(TOUR_DUMP, JSON.stringify(req.body, null, 2));
  res.json({ ok: true, path: ".station_tour_calibration.json" });
});
app.get("/api/dev/capture-tour", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  if (!existsSync(TOUR_DUMP)) {
    res.status(404).json({ error: "none" });
    return;
  }
  res.type("json").send(readFileSync(TOUR_DUMP, "utf8"));
});

const SPLAT_LIVE_HIDE = `<style id="splat-live-hide">
html.splat-live .dev-only,html.splat-live #splatCal,html.splat-live #splatOpHud,
html.splat-live #splatOpBadge,html.splat-live #splatOpen,html.splat-live #splatSrc,
html.splat-live #splatHint,html.splat-live #splatActions,html.splat-live .splat-cal,
html.splat-live .splat-src{display:none!important}
</style>
<script>document.documentElement.classList.add("splat-live");window.__SPLAT_DEV=false;window.__SPLAT_OPERATOR_ENABLED=false;</script>`;

function sendSyntheticPovHtml(res: express.Response) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  if (process.env.NODE_ENV === "production") {
    let html = readFileSync(SYNTHETIC_POV_HTML, "utf8");
    if (!html.includes("splat-live-hide") && !html.includes("splat-live")) {
      html = html.replace("<head>", `<head>${SPLAT_LIVE_HIDE}`);
    }
    res.type("html").send(html);
    return;
  }
  res.sendFile(SYNTHETIC_POV_HTML);
}

// Synthetic POV — serve before /lab static so production can strip dev HUD.
app.get(
  ["/synthetic-pov", "/synthetic-pov/", "/lab/synthetic-pov.html"],
  (_req, res) => sendSyntheticPovHtml(res),
);

// Serve large lab assets with long cache (splats, GLBs, video) — HTML stays no-store.
const LAB_ASSETS_DIR = join(EVAL_LAB_PUBLIC, "assets");
const OPERATOR_GLB_RE = /\/operator(?:-[^/]+)?\.glb$/i;
app.use("/lab/assets", (req, res, next) => {
  if (process.env.NODE_ENV === "production" && OPERATOR_GLB_RE.test(req.path)) {
    res.status(404).end();
    return;
  }
  next();
});
app.use(
  "/lab/assets",
  express.static(LAB_ASSETS_DIR, {
    maxAge: process.env.NODE_ENV === "production" ? 604_800_000 : 0,
    setHeaders(res, filePath) {
      if (/\.(spz|glb|jpe?g|mp4|webp|ply|svg)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      }
    },
  }),
);

// Serve the eval lab HTML directly so a single `npm run dev` is enough
// to open http://localhost:3001/lab/ and demo the whole thing.
// Path resolution lives in ./paths.ts — works in dev (tsx) and prod
// (compiled dist/) without hard-coded relative offsets.
app.use("/lab", express.static(EVAL_LAB_PUBLIC));

// Read-only line data (torque tables, error rates, ST.100 steps, parts
// catalogue) — the same files the glasses build ships. Serving them lets
// KB artifacts link straight to the source material.
app.use("/shared-data", express.static(join(SHARED_DIR, "data")));

// Root + /login both serve the tenant-specific login page. Auth is
// completed client-side against /api/auth/login; on success the SPA
// stores a session blob in localStorage and forwards to /welcome/ then /lab/.
app.get(["/", "/login", "/login/"], (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(LOGIN_HTML);
});

app.get(["/welcome", "/welcome/"], (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(WELCOME_HTML);
});

// Unified platform home — chat + the three services (post-login landing).
app.get(["/home", "/home/"], (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(HOME_HTML);
});

// Facility knowledge base — per-station node graphs + component references.
app.get(["/knowledge", "/knowledge/"], (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(KNOWLEDGE_HTML);
});

app.get("/lab/", (_req, res) => {
  // Force the browser to revalidate on every load so dev-iteration changes
  // to brain-eval-lab.html show up after a normal refresh.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(LAB_HTML);
});

app.use(
  (
    err: Error & { issues?: unknown },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    // eslint-disable-next-line no-console
    console.error("[error]", err.message);
    res.status(400).json({ error: err.message, issues: err.issues });
  },
);

app.listen(config.port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[brain-eval] listening on :${config.port}  stubMode=${stubMode}  ` +
      `procedure=${specs.procedure.proceduralActivity.label} ` +
      `steps=${specs.procedure.keysteps.length}`,
  );
});
