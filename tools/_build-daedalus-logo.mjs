/**
 * Build the platform's Daedalus horizontal lockup from the brand source
 * `horizontal.svg`:
 *   • drops the baked full-canvas background rect so the mark sits on any surface
 *   • tightens the viewBox to the real content bounds (measured in Chrome), so
 *     a 12px-tall <img> is 12px of logo rather than 12px of mostly padding
 *   • emits a white-wordmark file for dark chrome and a near-black one for light
 *
 * Throwaway generator: `node tools/_build-daedalus-logo.mjs`
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "eval-lab/public/assets");

const src = readFileSync(join(root, "horizontal.svg"), "utf8");

// The first rect spans the whole canvas and is the only opaque backdrop.
const bare = src.replace(/<rect width="4418" height="1917" fill="black"\/>\s*/, "");
if (bare === src) throw new Error("background rect not found — source changed?");

// Measure the tight bounds of what's left.
const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();
await page.setContent(`<body style="margin:0">${bare}</body>`, { waitUntil: "load" });
const box = await page.evaluate(() => {
  const svg = document.querySelector("svg");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  // Wrap the drawable children so one getBBox() covers the union.
  [...svg.children].filter((c) => c.tagName !== "defs").forEach((c) => g.appendChild(c));
  svg.appendChild(g);
  const b = g.getBBox();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});
await browser.close();

// A hair of padding keeps the 1px cube strokes off the edge when downscaled.
const pad = 6;
const vb = [
  Math.round(box.x - pad),
  Math.round(box.y - pad),
  Math.round(box.width + pad * 2),
  Math.round(box.height + pad * 2),
].join(" ");

for (const [name, ink] of [
  ["daedalus-horizontal.svg", "white"],
  ["daedalus-horizontal-ink.svg", "#0b0d10"],
]) {
  const out = bare
    .replace(
      /^<svg width="4418" height="1917" viewBox="0 0 4418 1917"/,
      `<svg viewBox="${vb}"`,
    )
    // The single white path is the "Daedalus" wordmark; the cube faces are gradient-filled.
    .replace(/fill="white"/g, `fill="${ink}"`);
  writeFileSync(join(OUT, name), out);
  console.log(`wrote assets/${name}  viewBox="${vb}"  wordmark=${ink}`);
}
