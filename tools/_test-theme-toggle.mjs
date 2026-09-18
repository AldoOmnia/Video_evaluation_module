/**
 * Behavioural check for the theme toggle: default, click, persistence across a
 * navigation, and that the vendor mark follows. Screenshots only prove the
 * painted result of a pre-seeded value; this proves the control works.
 *
 *   node tools/_test-theme-toggle.mjs [baseUrl]
 */
import puppeteer from "puppeteer";

const base = process.argv[2] || "http://localhost:3010";
const SESSION = JSON.stringify({
  tenant: "comer",
  token: "dev",
  user: { email: "admin@comer.com", name: "Comer Admin", role: "admin" },
  expiresAt: Date.now() + 8 * 3600 * 1000,
});

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.evaluateOnNewDocument((s) => {
  localStorage.setItem("omnia.session", s);
  localStorage.setItem("omnia.introSeen", "1");
}, SESSION);

const state = () =>
  page.evaluate(() => ({
    cls: document.documentElement.className.includes("light") ? "light" : "dark",
    stored: localStorage.getItem("daedalus.theme"),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    mark: getComputedStyle(document.querySelector(".vendor-mark") || document.body)
      .backgroundImage.match(/daedalus-horizontal(-ink)?\.svg/)?.[0] ?? "n/a",
    knobX: (() => {
      const k = document.querySelector(".theme-toggle .knob");
      return k ? getComputedStyle(k).transform : "n/a";
    })(),
  }));

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
};

// OS set to light on purpose: the platform must still start dark.
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.goto(base + "/home/", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1200));

let s = await state();
check("default theme (OS is light)", s.cls, "dark");
check("default stores nothing yet", String(s.stored), "null");
check("default canvas", s.bodyBg, "rgb(5, 5, 5)");
check("default mark", s.mark, "daedalus-horizontal.svg");

await page.click(".theme-toggle");
await new Promise((r) => setTimeout(r, 700));
s = await state();
check("after click -> class", s.cls, "light");
check("after click -> stored", s.stored, "light");
check("after click -> canvas", s.bodyBg, "rgb(255, 255, 255)");
check("after click -> ink mark", s.mark, "daedalus-horizontal-ink.svg");
check("knob slid left", s.knobX, "matrix(1, 0, 0, 1, 0, 0)");

// Persistence across a real navigation to a different page.
await page.goto(base + "/knowledge/", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1500));
s = await state();
check("persists on /knowledge", s.cls, "light");
check("persists canvas", s.bodyBg, "rgb(255, 255, 255)");

// And back to dark.
await page.click(".theme-toggle");
await new Promise((r) => setTimeout(r, 700));
s = await state();
check("toggles back -> class", s.cls, "dark");
check("toggles back -> stored", s.stored, "dark");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
await browser.close();
process.exit(fails ? 1 : 0);
