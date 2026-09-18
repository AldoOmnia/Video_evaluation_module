/**
 * Drive the real sign-in form and report what the page shows. Catches the
 * class of failure where the API rejects the request (CORS, validation) and
 * the form surfaces it as an error banner.
 *
 *   node tools/_test-signin.mjs [baseUrl]
 */
import puppeteer from "puppeteer";

const base = process.argv[2] || "http://localhost:3010";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push("console: " + m.text().slice(0, 140));
});
page.on("requestfailed", (r) => problems.push(`net: ${r.url()} ${r.failure()?.errorText}`));
page.on("response", async (r) => {
  if (r.status() < 400) return;
  let body = "";
  try {
    body = (await r.text()).slice(0, 300);
  } catch {}
  problems.push(`http ${r.status()} ${r.url()}${body ? "\n      body: " + body : ""}`);
});

/* No localStorage.clear() here: evaluateOnNewDocument runs on every document,
   so it would also fire on the page login redirects to and wipe the session
   that was just stored. A freshly launched browser starts empty anyway. */
await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1500));

page.on("request", (r) => {
  if (r.url().includes("/api/auth/login")) problems.push(`POST sent: ${r.postData()}`);
});

await page.type("#username", "admin@comel.com".replace("comel", "comer"));
await page.type("#password", "rockford123");
const filled = await page.evaluate(() => ({
  u: document.querySelector("#username")?.value,
  p: document.querySelector("#password")?.value ? "set" : "empty",
}));
console.log("fields     :", JSON.stringify(filled));
await page.click('button[type="submit"]');
await new Promise((r) => setTimeout(r, 4000));

const out = await page.evaluate(() => ({
  url: location.pathname,
  session: !!localStorage.getItem("omnia.session"),
  // Any visible text that looks like an error banner.
  errors: [...document.querySelectorAll("*")]
    .filter((e) => e.offsetParent && /error|not allowed|failed|invalid/i.test(e.textContent || "") && e.children.length === 0)
    .map((e) => e.textContent.trim().slice(0, 120))
    .slice(0, 4),
}));

console.log("landed on :", out.url);
console.log("session set:", out.session);
console.log("page errors:", out.errors.length ? out.errors : "none");
console.log("request problems:", problems.length ? problems : "none");
await browser.close();
process.exit(out.session && out.url !== "/login" ? 0 : 1);
