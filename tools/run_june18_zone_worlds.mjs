/**
 * Generate 7 single-pano marble-1.1-plus worlds (one per tour zone).
 * Run: npm run build --workspace=backend && node tools/run_june18_zone_worlds.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const line of readFileSync(join(ROOT, "backend/.env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ZONES = [
  { label: "Station 1", tier: "core", asset: "june18_pano_01.jpg" },
  { label: "Station 2", tier: "core", asset: "june18_pano_02.jpg" },
  { label: "Station 3", tier: "core", asset: "june18_pano_03.jpg" },
  { label: "Station 4", tier: "core", asset: "june18_pano_04.jpg" },
  { label: "Perimeter 5", tier: "outer", asset: "june18_pano_05.jpg" },
  { label: "Perimeter 6", tier: "outer", asset: "june18_pano_06.jpg" },
  { label: "Perimeter 7", tier: "outer", asset: "june18_pano_07.jpg" },
];

const PROMPT =
  "Industrial pinion guide assembly workstation, manufacturing bay, " +
  "workbench with gearbox pinion housing, torque tools, blue parts bins, " +
  "concrete factory floor, bright overhead lighting. Faithful photo reconstruction.";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSplat(get, worldId, maxTries = 40) {
  for (let i = 0; i < maxTries; i++) {
    const w = await get(worldId);
    if (w.done && w.spz) return w;
    await sleep(5000);
  }
  throw new Error(`splat not ready for ${worldId}`);
}

async function generateOne(gen, poll, get, zone) {
  console.log(`\n── ${zone.label} (${zone.asset}) ──`);
  const out = await gen({
    model: "marble-1.1-plus",
    localAsset: zone.asset,
    isPano: true,
    isPublic: true,
    displayName: `Comer · ${zone.label} (June18)`,
    prompt: PROMPT,
  });
  const opId = out.operationId;
  let worldId = out.worldId;
  const t0 = Date.now();
  while (true) {
    await sleep(8000);
    const s = await poll(opId);
    const sec = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`  [${sec}s] ${s.status}${s.progress ? " · " + s.progress : ""}\r`);
    if (s.error) throw new Error(s.error);
    if (s.done) {
      worldId = s.worldId ?? worldId;
      console.log(`\n  operation done · worldId=${worldId}`);
      break;
    }
  }
  if (!worldId) throw new Error("no worldId");
  const w = await waitForSplat(get, worldId);
  console.log(`  splat ready · ${Object.keys(w.spz).join(", ")}`);
  return { ...zone, id: worldId, marbleUrl: w.marbleUrl };
}

async function main() {
  const mod = await import(join(ROOT, "backend/dist/backend/src/services/worldlabs.js"));
  const { generateWorld, pollOperation, getWorld } = mod;
  const results = [];
  for (const zone of ZONES) {
    try {
      results.push(await generateOne(generateWorld, pollOperation, getWorld, zone));
    } catch (e) {
      const msg = String(e.message || e);
      console.error(`\nFAILED ${zone.label}:`, msg);
      if (/402|insufficient|credit/i.test(msg)) break;
      throw e;
    }
  }
  const outPath = join(ROOT, "reconstruction/june18_zone_worlds.json");
  writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), zones: results }, null, 2));
  console.log(`\n=== done: ${results.length}/${ZONES.length} zones ===`);
  console.log("saved", outPath);
  for (const r of results) console.log(`  ${r.label}: ${r.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
