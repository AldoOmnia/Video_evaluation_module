/** Drive a real seed through the button and watch the KPI notes: verb while the
 *  work runs, figures afterwards, never stuck in between.
 *
 *    node tools/_check_busy_notes.mjs [baseUrl]
 */
import puppeteer from "puppeteer";

const base = process.argv[2] || "http://localhost:3010";
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tenant: "comer", username: "admin@comer.com", password: "rockford123" }),
}).then((r) => r.json());

const api = (method, body) =>
  fetch(`${base}/api/reshim/sample`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

await api("DELETE");

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.evaluateOnNewDocument((token) => {
  localStorage.setItem(
    "omnia.session",
    JSON.stringify({ tenant: "comer", token, user: "admin@comer.com", expiresAt: Date.now() + 3600e3 }),
  );
}, login.token);
page.on("dialog", (d) => d.accept());          // confirm the seed

const read = () =>
  page.evaluate(() => ({
    busy: document.getElementById("kpis").hasAttribute("data-busy"),
    notes: [...document.querySelectorAll("#kpis .n")].map((n) => n.textContent),
    seedDim: document.getElementById("seed-btn").classList.contains("running"),
    units: document.getElementById("k-units").textContent,
  }));

await page.goto(`${base}/reshim/`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 900));
console.log("empty:   ", JSON.stringify(await read()));

// Untick email so the seed cannot send, then click for real.
await page.evaluate(() => (document.getElementById("also-email-cb").checked = false));
const clicked = page.click("#seed-btn");
await new Promise((r) => setTimeout(r, 60));
console.log("mid-seed:", JSON.stringify(await read()));
await clicked;

for (let i = 0; i < 40; i++) {
  const s = await read();
  if (!s.busy) { console.log("settled: ", JSON.stringify(s)); break; }
  await new Promise((r) => setTimeout(r, 250));
}

await api("DELETE");
await browser.close();
