/** Confirm the Run-now button posts skipEmail=false by default, and true when
 *  the box is unticked. Intercepts the POST so nothing actually runs. */
import puppeteer from "puppeteer";
const base = process.argv[2] || "http://localhost:3010";
const b = await puppeteer.launch({ headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const p = await b.newPage();
await p.setRequestInterception(true);
let posted = null;
p.on("request", (r) => {
  if (r.url().includes("/api/reshim/trigger") && r.method() === "POST") {
    posted = r.postData();
    return r.respond({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  }
  r.continue();
});
p.on("dialog", (d) => d.accept());            // accept the confirm prompt
await p.goto(`${base}/reshim/`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));

const state = await p.evaluate(() => ({
  checked: document.getElementById("also-email-cb").checked,
  disabled: document.getElementById("also-email-cb").disabled,
}));
console.log("default checked:", state.checked, " disabled by gating:", state.disabled);

// Force the controls live so the POST can be observed even on a gated host.
await p.evaluate(() => {
  document.getElementById("run-btn").disabled = false;
  document.getElementById("also-email-cb").disabled = false;
});
await p.click("#run-btn");
await new Promise((r) => setTimeout(r, 800));
console.log("posted with box checked  :", posted);

posted = null;
await p.evaluate(() => { document.getElementById("also-email-cb").checked = false;
  document.getElementById("run-btn").classList.remove("running"); });
await p.click("#run-btn");
await new Promise((r) => setTimeout(r, 800));
console.log("posted with box unticked :", posted);
await b.close();
