/**
 * Build the favicon set from the brand source `horizontal.svg`.
 *
 * The horizontal lockup is unreadable at 16px, so the icon is the isometric
 * cube on its own: drop the baked background rect and the wordmark path, keep
 * the five gradient faces, then square up the viewBox so the cube is centred
 * rather than letterboxed.
 *
 * Rasterising goes through Chrome because the repo has no image library, and
 * Chrome is already a dependency of every other shot script here.
 *
 * Throwaway generator: `node tools/_build-daedalus-favicon.mjs`
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "eval-lab/public/assets");

const src = readFileSync(join(root, "horizontal.svg"), "utf8");

const noBg = src.replace(/<rect width="4418" height="1917" fill="black"\/>\s*/, "");
if (noBg === src) throw new Error("background rect not found — source changed?");

// The single white path is the wordmark; everything else is the cube.
const markOnly = noBg.replace(/<path d="M2326\.43[\s\S]*?fill="white"\/>\s*/, "");
if (markOnly === noBg) throw new Error("wordmark path not found — source changed?");

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();

// Measure the cube's tight bounds, then centre it in a square box.
await page.setContent(`<body style="margin:0">${markOnly}</body>`, { waitUntil: "load" });
const box = await page.evaluate(() => {
  const svg = document.querySelector("svg");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  [...svg.children].filter((c) => c.tagName !== "defs").forEach((c) => g.appendChild(c));
  svg.appendChild(g);
  const b = g.getBBox();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});

const pad = 8; // keeps the 1px face strokes off the edge when downscaled
const side = Math.round(Math.max(box.width, box.height) + pad * 2);
const vb = [
  Math.round(box.x + box.width / 2 - side / 2),
  Math.round(box.y + box.height / 2 - side / 2),
  side,
  side,
].join(" ");

const markSvg = markOnly.replace(
  /^<svg width="4418" height="1917" viewBox="0 0 4418 1917"/,
  `<svg viewBox="${vb}"`,
);
writeFileSync(join(OUT, "daedalus-mark.svg"), markSvg);
console.log(`wrote assets/daedalus-mark.svg  viewBox="${vb}"`);

/* Rasterise. Transparent for the browser-chrome icons; iOS composites
   apple-touch-icon onto white unless we bake our own backdrop, and the cube's
   dark strokes disappear on white, so that one gets the brand ink behind it. */
async function png(size, { opaque = false, inset = 0 } = {}) {
  const pxInset = Math.round(size * inset);
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;${
      opaque ? "background:#0b0d10;" : ""
    }display:flex;align-items:center;justify-content:center">
       <div style="width:${size - pxInset * 2}px;height:${size - pxInset * 2}px">${markSvg}</div>
     </body>`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => {
    const svg = document.querySelector("svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
  });
  return page.screenshot({ omitBackground: !opaque, type: "png" });
}

const icoSizes = [16, 32, 48];
const icoPngs = [];
for (const s of icoSizes) icoPngs.push(await png(s));

for (const [name, buf] of [
  ["favicon-32.png", icoPngs[1]],
  ["favicon-192.png", await png(192)],
  ["favicon-512.png", await png(512)],
  // iOS rounds the corners itself, so the cube gets breathing room instead.
  ["apple-touch-icon.png", await png(180, { opaque: true, inset: 0.14 })],
]) {
  writeFileSync(join(OUT, name), buf);
  console.log(`wrote assets/${name}  ${buf.length}B`);
}

await browser.close();

/* ICO container. Vista and later read embedded PNGs directly, which spares us
   a BMP encoder; the 16/32/48 trio covers tab, bookmark bar and Windows list. */
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoSizes.length, 4);

let offset = 6 + icoSizes.length * 16;
const dir = [];
for (const [i, s] of icoSizes.entries()) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); // width
  e.writeUInt8(s === 256 ? 0 : s, 1); // height
  e.writeUInt8(0, 2); // palette size (0 = no palette)
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(icoPngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += icoPngs[i].length;
  dir.push(e);
}
const ico = Buffer.concat([header, ...dir, ...icoPngs]);
writeFileSync(join(OUT, "favicon.ico"), ico);
console.log(`wrote assets/favicon.ico  ${ico.length}B  (${icoSizes.join("/")})`);
