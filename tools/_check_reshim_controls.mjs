/** Reshim dashboard controls: the email checkbox must stay present, ticked and
 *  usable even on a host that cannot run the agent. Seed/clear sample must be
 *  gone — real archived reports are what this page shows.
 *
 *    node tools/_check_reshim_controls.mjs [baseUrl]
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

await page.goto(`${base}/reshim/`, { waitUntil: "networkidle0" });
await page.waitForSelector("#runs-tbody", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 700));

const s = await page.evaluate(() => {
  const seen = (el) => {
    if (!el || el.hidden) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) > 0.6;
  };
  const cb = document.getElementById("also-email-cb");
  const notice = document.getElementById("trigger-note");
  return {
    emailVisible: seen(document.getElementById("email-toggle")),
    emailChecked: !!cb?.checked,
    emailEnabled: !!cb && !cb.disabled,
    seedPresent: !!document.getElementById("seed-btn"),
    clearPresent: !!document.getElementById("clear-btn"),
    runDisabled: document.getElementById("run-btn").disabled,
    noticeShown: !notice.hidden,
    dates: [...document.querySelectorAll("tbody tr[data-date]")].map((tr) => tr.dataset.date),
  };
});

console.log(`email checkbox   visible=${s.emailVisible} checked=${s.emailChecked} enabled=${s.emailEnabled}`);
console.log(`sample controls  seed=${s.seedPresent} clear=${s.clearPresent}`);
console.log(`run now          disabled=${s.runDisabled} notice=${s.noticeShown}`);
console.log(`runs             ${s.dates.join(", ") || "(none)"}`);

const caps = await fetch(`${base}/api/reshim/capabilities`).then((r) => r.json());
const sampleGone = await fetch(`${base}/api/reshim/sample`, { method: "POST" }).then((r) => r.status);

console.log(`capabilities     sampleRuns=${caps.sampleRuns ?? "absent"}`);
console.log(`POST /sample     HTTP ${sampleGone}`);

const fail = [];
if (!s.emailChecked) fail.push("email checkbox unticked");
if (s.emailVisible === undefined) fail.push("email toggle missing");
if (s.seedPresent || s.clearPresent) fail.push("seed/clear buttons are still on the page");
if (caps.sampleRuns != null) fail.push("capabilities still reports sampleRuns");
if (sampleGone !== 404) fail.push(`POST /sample should be 404, got ${sampleGone}`);

await page.screenshot({ path: "tools/_reshim-controls.png" });
await browser.close();

if (fail.length) {
  console.error("\nFAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("\nok");
