/**
 * One-shot: upload 8 June18 panos → unified marble-1.1-plus world (Auto Layout).
 * Run from repo root: node tools/run_june18_unified_world.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load backend/.env
for (const line of readFileSync(join(ROOT, "backend/.env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { generateWorld, pollOperation, getWorld } = await import(
  join(ROOT, "backend/dist/backend/src/services/worldlabs.js")
).catch(async () =>
  // dev: use tsx-compatible path — fall back to dynamic import via shell tsx
  null,
);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ASSETS = Array.from({ length: 8 }, (_, i) =>
  `june18_pano_${String(i + 1).padStart(2, "0")}.jpg`,
);

const PROMPT =
  "Industrial pinion guide assembly workstation in a manufacturing bay: " +
  "workbench with gearbox pinion housing, torque tools, blue parts bins, " +
  "conveyor and press area, concrete floor, bright overhead factory lighting. " +
  "Faithful reconstruction of an existing factory space.";

async function main() {
  // Prefer compiled backend; if missing, instruct to build
  let gen, poll, get;
  try {
    const mod = await import(
      join(ROOT, "backend/dist/backend/src/services/worldlabs.js")
    );
    gen = mod.generateWorld;
    poll = mod.pollOperation;
    get = mod.getWorld;
  } catch {
    console.error("Run: npm run build --workspace=backend first");
    process.exit(1);
  }

  console.log("Uploading 8 panos + starting unified generation (marble-1.1-plus)…");
  const started = Date.now();
  const out = await gen({
    model: "marble-1.1-plus",
    multiImageAssets: ASSETS,
    reconstruct: true,
    isPublic: true,
    displayName: "Comer · pinion guide station (June18 unified)",
    prompt: PROMPT,
  });
  console.log("operationId:", out.operationId, "worldId:", out.worldId ?? "(pending)");

  const opId = out.operationId;
  let worldId = out.worldId;

  while (true) {
    await sleep(8000);
    const s = await poll(opId);
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(
      `[${elapsed}s] done=${s.done} status=${s.status} progress=${s.progress ?? ""} worldId=${s.worldId ?? ""}`,
    );
    if (s.error) {
      console.error("FAILED:", s.error);
      process.exit(1);
    }
    if (s.done) {
      worldId = s.worldId ?? worldId;
      break;
    }
  }

  if (!worldId) {
    console.error("No worldId returned");
    process.exit(1);
  }

  // Wait for splat assets
  for (let i = 0; i < 60; i++) {
    const w = await get(worldId);
    if (w.done && w.spz) {
      console.log("\n=== SUCCESS ===");
      console.log("worldId:", worldId);
      console.log("marbleUrl:", w.marbleUrl);
      console.log("spz_lods:", Object.keys(w.spz));
      writeFileSync(
        join(ROOT, "reconstruction/june18_unified_world.json"),
        JSON.stringify({ worldId, marbleUrl: w.marbleUrl, spz: Object.keys(w.spz) }, null, 2),
      );
      return worldId;
    }
    await sleep(5000);
    console.log(`waiting for splat assets… (${i + 1})`);
  }
  console.error("World created but splat not ready yet. worldId:", worldId);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
