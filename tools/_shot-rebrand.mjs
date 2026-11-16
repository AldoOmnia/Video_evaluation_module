/**
 * Screenshot the three pages whose footers carry the vendor mark, to confirm
 * the Daedalus lockup reads correctly on the real surface.
 * Throwaway: `node tools/_shot-rebrand.mjs [baseUrl]`
 */
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] || "http://localhost:3001";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

// A real sign-in. The password is not in this script.
await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: join(root, "tools/_rebrand-login.png") });
const email = process.env.EMOTIV_AUTH_EMAIL || "";
const password = process.env.COMER_SIGNIN_PASSWORD || "";
if (!email || !password) {
  console.error("Set EMOTIV_AUTH_EMAIL and COMER_SIGNIN_PASSWORD to shoot the signed-in pages.");
  await browser.close();
  process.exit(2);
}
await page.type('input[type="email"]', email);
await page.type('input[type="password"]', password);
await page.click('button[type="submit"]');
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate(() => localStorage.setItem("omnia.introSeen", "1"));

for (const [name, path] of [
  ["home", "/home"],
  ["welcome", "/welcome"],
]) {
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: join(root, `tools/_rebrand-${name}.png`) });
  const marks = await page.evaluate(() =>
    [...document.images]
      .filter((i) => /daedalus|omnia/i.test(i.src))
      .map((i) => ({
        src: i.src.split("/").pop(),
        alt: i.alt,
        loaded: i.naturalWidth > 0,
        shown: `${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)}`,
      })),
  );
  console.log(name.padEnd(9), JSON.stringify(marks));
}
await browser.close();
