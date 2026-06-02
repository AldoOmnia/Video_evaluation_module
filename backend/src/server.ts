import express from "express";
import cors from "cors";

import { config, stubMode } from "./config.js";
import { specs } from "./services/specs.js";
import { brainChatRouter } from "./routes/brainChat.js";
import { evalRouter } from "./routes/eval.js";
import { specRouter } from "./routes/spec.js";
import { queryRouter } from "./routes/query.js";
import { authRouter } from "./routes/auth.js";
import { worldLabsRouter } from "./routes/worldlabs.js";
import { worldLabsConfigured } from "./services/worldlabs.js";
import {
  EVAL_LAB_PUBLIC,
  LAB_HTML,
  LOGIN_HTML,
  WELCOME_HTML,
  SYNTHETIC_POV_HTML,
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
app.use("/api/worldlabs", worldLabsRouter);
app.use("/query", queryRouter); // Rokid APK compatibility

// Serve the eval lab HTML directly so a single `npm run dev` is enough
// to open http://localhost:3001/lab/ and demo the whole thing.
// Path resolution lives in ./paths.ts — works in dev (tsx) and prod
// (compiled dist/) without hard-coded relative offsets.
app.use("/lab", express.static(EVAL_LAB_PUBLIC));

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

// Synthetic POV — Rerun-style multi-panel view: live 3D SLAM viewport,
// worker POV video, SLAM/eye tiles, and a World Labs splat embed slot.
// Configurable via query params (?video=, ?splat=, ?dur=).
app.get(["/synthetic-pov", "/synthetic-pov/"], (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(SYNTHETIC_POV_HTML);
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
