/** Drive Refresh and watch the KPI notes: verb while the work runs, figures
 *  afterwards, never stuck in between.
 *
 *    node tools/_check_busy_notes.mjs [baseUrl]
 */
import puppeteer from "puppeteer";

const base = process.argv[2] || "http://localhost:3010";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem(
    "omnia.session",
    JSON.stringify({ tenant: "comer", token: "test-token", user: "admin@comer.com", expiresAt: Date.now() + 3600e3 }),
  );
});

const read = () =>
  page.evaluate(() => ({
    busy: document.getElementById("kpis").hasAttribute("data-busy"),
    notes: [...document.querySelectorAll("#kpis .n")].map((n) => n.textContent),
    refreshDim: document.getElementById("refresh-btn").classList.contains("running"),
    units: document.getElementById("k-units").textContent,
  }));

await page.goto(`${base}/reshim/`, { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.getElementById("k-units").textContent !== "—", { timeout: 15000 });
console.log("loaded:  ", JSON.stringify(await read()));

const clicked = page.click("#refresh-btn");
await new Promise((r) => setTimeout(r, 40));
console.log("mid:     ", JSON.stringify(await read()));
await clicked;

for (let i = 0; i < 40; i++) {
  const s = await read();
  if (!s.busy) {
    console.log("settled: ", JSON.stringify(s));
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}

await browser.close();
