import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, stubMode } from "./config.js";
import { specs } from "./services/specs.js";
import { brainChatRouter } from "./routes/brainChat.js";
import { evalRouter } from "./routes/eval.js";
import { specRouter } from "./routes/spec.js";
import { queryRouter } from "./routes/query.js";
import { authRouter } from "./routes/auth.js";

const app = express();

app.use(cors({ origin: config.allowedOrigins, credentials: false }));
app.use(express.json({ limit: "12mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    stubMode,
    procedure: specs.procedure.proceduralActivity.label,
    steps: specs.procedure.keysteps.length,
    hardwareProfiles: Object.keys(specs.hardware.profiles).length,
    strategies: Object.keys(specs.strategies.strategies).length,
  });
});

app.use("/api/spec", specRouter);
app.use("/api/brain/chat", brainChatRouter);
app.use("/api/eval", evalRouter);
app.use("/api/auth", authRouter);
app.use("/query", queryRouter); // Rokid APK compatibility

// Serve the eval lab HTML directly so a single `npm run dev:backend` is
// enough to open http://localhost:3001/lab/ and demo the whole thing.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
app.use("/lab", express.static(join(REPO_ROOT, "eval-lab", "public")));

// Root + /login both serve the tenant-specific login page. Auth is
// completed client-side against /api/auth/login; on success the SPA
// stores a session blob in localStorage and forwards to /lab/.
app.get(["/", "/login", "/login/"], (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(join(REPO_ROOT, "eval-lab", "public", "login.html"));
});

app.get("/lab/", (_req, res) => {
  // Force the browser to revalidate on every load so dev-iteration changes
  // to brain-eval-lab.html show up after a normal refresh.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(join(REPO_ROOT, "brain-eval-lab.html"));
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
