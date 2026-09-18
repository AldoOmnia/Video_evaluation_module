/** Reshim dashboard controls: the email checkbox must be present, ticked and
 *  usable even on a host that cannot run the agent, and the sample-data pair
 *  must reflect what is actually on disk.
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

// The page gates on the platform session, and the sample routes want its token.
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tenant: "comer", username: "admin@comer.com", password: "rockford123" }),
}).then((r) => r.json());

await page.evaluateOnNewDocument((token) => {
  localStorage.setItem(
    "omnia.session",
    JSON.stringify({ tenant: "comer", token, user: "admin@comer.com", expiresAt: Date.now() + 3600e3 }),
  );
}, login.token);

const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.message());
  d.dismiss();                       // never actually seed or send from this check
});

async function state() {
  await page.goto(`${base}/reshim/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 900));
  return page.evaluate(() => {
    const seen = (el) => {
      if (!el || el.hidden) return false;
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.6;
    };
    const cb = document.getElementById("also-email-cb");
    const notice = document.getElementById("trigger-note");
    return {
      emailVisible: seen(document.getElementById("email-toggle")),
      emailChecked: cb.checked,
      emailEnabled: !cb.disabled,
      seedVisible: seen(document.getElementById("seed-btn")),
      clearVisible: seen(document.getElementById("clear-btn")),
      clearLabel: document.getElementById("clear-btn").textContent.trim(),
      runDisabled: document.getElementById("run-btn").disabled,
      noticeShown: !notice.hidden,
      noticeWidth: notice.getBoundingClientRect().width,
      kpiWidth: document.getElementById("kpis").getBoundingClientRect().width,
      rows: document.querySelectorAll("#runs-tbody tr").length,
      emptyText: document.querySelector("#runs-tbody .empty")?.textContent.trim().slice(0, 60) ?? null,
      mockBadge: !document.getElementById("mock-chip").hidden,
    };
  });
}

const report = (label, s) => {
  console.log(`\n${label}`);
  console.log(`  email checkbox   visible=${s.emailVisible} checked=${s.emailChecked} enabled=${s.emailEnabled}`);
  console.log(`  seed / clear     seed=${s.seedVisible} clear=${s.clearVisible} ${JSON.stringify(s.clearLabel)}`);
  console.log(`  run now          disabled=${s.runDisabled}  notice=${s.noticeShown}`);
  console.log(`  notice width     ${Math.round(s.noticeWidth)}px vs KPI row ${Math.round(s.kpiWidth)}px`);
  console.log(`  table            rows=${s.rows} mockBadge=${s.mockBadge}`);
  if (s.emptyText) console.log(`  empty state      "${s.emptyText}…"`);
};

const token = login.token;
const api = (path, method, body) =>
  fetch(`${base}/api/reshim${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

await api("/sample", "DELETE");
report("── with no sample data on disk ──", await state());
await page.screenshot({ path: "tools/_reshim-empty.png" });

await api("/sample", "POST", { days: 30, email: false });
report("── after seeding 30 sample runs ──", await state());
await page.screenshot({ path: "tools/_reshim-controls.png" });

// The confirm text is the last line of defence before mail goes out.
await page.click("#seed-btn");
await new Promise((r) => setTimeout(r, 400));
console.log(`\n  seed confirm: ${JSON.stringify(dialogs[0]?.slice(0, 120) ?? "none")}…`);

await api("/sample", "DELETE");
await browser.close();
