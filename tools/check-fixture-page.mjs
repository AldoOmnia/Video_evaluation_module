#!/usr/bin/env node
/**
 * Camera-support generator — end-to-end check in a real browser.
 *
 *   npm run dev                         # in another terminal
 *   node tools/check-fixture-page.mjs   # [--base http://localhost:3001] [--shots dir] [--step] [--ai]
 *
 * Drives /fixture/ the way a user would — load the sample scan, set the pose,
 * move sliders, export — and checks what the page reports against what it
 * drew. `--step` also builds a STEP through the server (slow: 15–45 s).
 * `--ai` exercises the assistant and auto-locate, which spend API tokens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);
const base = arg("base", "http://localhost:3001");
const shots = arg("shots", "/tmp/fixture_shots");
mkdirSync(shots, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// Puppeteer's own Chrome is only present if its install script ran; fall back
// to the one on this machine.
const systemChrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
let executablePath;
try {
  executablePath = existsSync(puppeteer.executablePath()) ? undefined : systemChrome;
} catch {
  executablePath = systemChrome;
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

/* A link to the tool goes through sign-in and comes back to the tool. */
console.log("Sign-in");
{
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("omnia.session"));
  await page.goto(`${base}/fixture`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {});
  const sent = new URL(page.url());
  ok("the tool's address, opened without a session, goes to sign-in and remembers where it was going", sent.pathname === "/login" && sent.searchParams.get("next") === "/fixture", sent.pathname + sent.search);
  // What the sign-in form does on success, without a password in this file.
  const signIn = async (url) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.setItem("omnia.session", JSON.stringify({ tenant: "comer", username: "check", expiresAt: Date.now() + 3600e3 }));
      localStorage.setItem("omnia.introSeen", "1");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {});
    const at = new URL(page.url());
    await page.evaluate(() => localStorage.removeItem("omnia.session"));
    return at;
  };
  const landed = await signIn(sent.href);
  ok("once signed in, the tool opens", landed.pathname === "/fixture" && landed.host === new URL(base).host, landed.href);
  const away = await signIn(`${base}/login?next=${encodeURIComponent("//example.com/fixture")}`);
  const away2 = await signIn(`${base}/login?next=${encodeURIComponent("https://example.com/")}`);
  ok("sign-in only ever returns to a page on this site", [away, away2].every((u) => u.host === new URL(base).host && u.pathname.startsWith("/home")), `${away.pathname}, ${away2.pathname}`);
  await page.goto(`${base}/fixture/comer-cognex-camera-2800`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {});
  const named = new URL(page.url());
  ok("a configuration link, opened without a session, remembers the configuration", named.pathname === "/login" && named.searchParams.get("next") === "/fixture/comer-cognex-camera-2800", named.pathname + named.search);
  const namedLanded = await signIn(named.href);
  ok("…and sign-in opens that configuration", namedLanded.pathname === "/fixture/comer-cognex-camera-2800", namedLanded.pathname);
  // The gated page stops its own script with "no session" on the way to
  // sign-in: expected here, an error anywhere after this.
  errors.length = 0;
}

// A signed-in session, as the login page would leave it.
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  localStorage.setItem("omnia.session", JSON.stringify({ tenant: "comer", username: "check", expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
});

const shot = async (name) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: join(shots, `${name}.png`) });
};
const waitResult = (timeout = 30000) => page.waitForFunction(() => window.__fixture?.idle(), { timeout });
const text = (id) => page.$eval(`#${id}`, (el) => el.textContent.trim());

console.log("\nPage");
await page.goto(`${base}/fixture/`, { waitUntil: "networkidle2" });
await page.waitForFunction(() => window.__fixture?.S.caps, { timeout: 20000 });
ok("page loads with a session", (await page.title()).startsWith("Camera support"));
await shot("01-empty");
const caps = await page.evaluate(() => window.__fixture.S.caps);
console.log(`        capabilities: assist=${caps.assist.available} locate=${caps.locate.available} step=${caps.step.available}`);
const sliderCount = (await (await fetch(`${base}/shared-data/fixture-params.json`)).json()).sliders.length;
ok("sliders are built from the shared schema", (await page.$$("#sliders-main .slider, #sliders-advanced .slider")).length === sliderCount, `${sliderCount} sliders`);
ok("structure controls are off until there is a pose and an anchor", await page.$eval("#sec-structure", (el) => el.classList.contains("is-off")));

console.log("\nSample scan");
await page.click("#btn-sample");
await page.waitForFunction(() => window.__fixture.S.scan, { timeout: 20000 });
ok("sample is announced with a filled chip", await page.$eval("#sample-chip", (el) => !el.hidden));
await shot("02-scan");

// Place the pose by clicking, the way a user does: project the known camera
// and target positions to the screen and click there.
const project = (p) => page.evaluate((p) => {
  const { cam3 } = window.__fixture;
  const c = document.getElementById("canvas").getBoundingClientRect();
  const m = cam3.matrixWorldInverse.elements, pr = cam3.projectionMatrix.elements;
  const v = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  const w = -v[2];
  return [c.left + ((pr[0] * v[0] + pr[8] * v[2]) / w * 0.5 + 0.5) * c.width, c.top + (1 - ((pr[5] * v[1] + pr[9] * v[2]) / w * 0.5 + 0.5)) * c.height];
}, p);
const truth = await page.evaluate(() => window.__fixture.S.scan.truth);
const clickAt = async (p) => { const [x, y] = await project(p); await page.mouse.click(x, y); };

await page.click("#btn-pick-camera");
await clickAt(truth.camera.center);
await page.waitForFunction(() => window.__fixture.S.pose, { timeout: 5000 });
const picked = await page.evaluate(() => window.__fixture.S.pose.center);
const off = Math.hypot(...picked.map((v, i) => v - truth.camera.center[i]));
ok("clicking the camera places it within 25 mm of where it is", off < 0.025, `${(off * 1000).toFixed(0)} mm off`);
await clickAt([0, 0, 0.76]); // top of the housing; mode moved on to "target" by itself
await page.waitForFunction(() => window.__fixture.S.target, { timeout: 5000 });
await page.waitForFunction(() => window.__fixture.S.armCount > 0, { timeout: 10000 });
const arm = await page.evaluate(() => ({ n: window.__fixture.S.armCount, of: window.__fixture.S.scan.count }));
ok("the temporary arm is found from the camera", arm.n > 2000 && arm.n < arm.of * 0.2, `${arm.n} of ${arm.of} points`);
await shot("03-pose-unlocked");

await page.click("#btn-anchor");
await clickAt([-0.42, -0.36, 0.47]);
await page.waitForFunction(() => window.__fixture.S.anchors.length === 1, { timeout: 5000 });
const anchor = await page.evaluate(() => window.__fixture.S.anchors[0]);
ok("clicking the bench gives a flat, upward anchor on its top", anchor.flat && anchor.n[2] > 0.99 && Math.abs(anchor.p[2] - 0.47) < 0.012, `z=${anchor.p[2].toFixed(3)} rms=${(anchor.rms * 1000).toFixed(1)} mm`);
ok("no structure before the pose is locked", await page.evaluate(() => !window.__fixture.S.sceneReady && !window.__fixture.S.result));

console.log("\nGenerate");
await page.click("#btn-lock");
await waitResult();
const poseLocked = await page.evaluate(() => JSON.stringify(window.__fixture.S.pose));
const mount0 = await page.evaluate(() => window.__fixture.S.result.mount.p);
let m = await page.evaluate(() => window.__fixture.S.result.metrics);
ok("a structure is generated once locked", m.triangles > 20000 && m.pieces === 1, `${m.triangles} triangles, ${m.feet} feet, ${(m.mass * 1000).toFixed(0)} g`);
ok("KPI cards show the result", (await text("k-defl")).startsWith((m.deflection * 1000).toFixed(2)) && /target .* mm · (met|not met)/.test(await text("n-defl")), `${await text("k-defl")} · ${await text("n-defl")}`);
await page.evaluate(() => window.__fixture.frame());
await shot("04-generated");

// Drag a slider with the mouse and watch it regenerate.
const drag = async (id, fraction) => {
  const box = await (await page.$(`#s-${id}`)).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  const frames = [];
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width * (0.5 + (fraction - 0.5) * (i / 12)), box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 60));
    frames.push(await page.evaluate(() => window.__fixture.S.result?.metrics.ms.mesh ?? 0));
  }
  await page.mouse.up();
  return frames;
};
const before = m.triangles;
const t0 = Date.now();
await drag("sweep", 0.95);
await waitResult();
m = await page.evaluate(() => window.__fixture.S.result.metrics);
ok("dragging a slider regenerates the structure", m.triangles !== before, `settled ${Date.now() - t0} ms after the drag began`);
const dragMs = await page.evaluate(async () => {
  const f = window.__fixture;
  const times = [];
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    await f.call("generate", { values: { ...f.S.values, split: 40 + i * 5 }, quality: "drag" });
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[3];
});
ok("a drag-quality update returns in under 200 ms", dragMs < 200, `${dragMs.toFixed(0)} ms median, worker round trip`);
await shot("05-sweep");

console.log("\nThe camera does not move");
let worst = 0;
for (const [id, v] of [["rigidity", 90], ["feet", 4], ["footprint", 280], ["split", 20], ["ties", 3], ["blend", 36], ["standoff", 140], ["clearance", 110], ["plateThickness", 14]]) {
  await page.evaluate((id, v) => window.__fixture.applyValues({ [id]: v }), id, v);
  await waitResult();
  const got = await page.evaluate((id) => window.__fixture.S.values[id], id);
  if (got !== v) { fail++; console.log(`  FAIL  ${id} did not take the value ${v}`); }
  const now = await page.evaluate(() => ({ pose: JSON.stringify(window.__fixture.S.pose), mount: window.__fixture.S.result.mount.p }));
  if (now.pose !== poseLocked) worst = Infinity;
  worst = Math.max(worst, Math.hypot(...now.mount.map((x, i) => x - mount0[i])));
}
ok("pose and mounting face unchanged after nine slider changes", worst === 0, `moved ${worst} m`);
m = await page.evaluate(() => window.__fixture.S.result.metrics);
ok("the result on screen is for the values on screen", m.feet === 4 && Math.abs(m.target - 2e-3 * 10 ** (-1.8)) < 1e-9 && (await text("n-defl")).includes("0.032"), `${m.feet} feet · ${await text("n-defl")}`);
await page.evaluate(() => window.__fixture.frame());
await shot("06-many-changes");
await page.click("#btn-reset");
await waitResult();

console.log("\nLooks");
await page.select("#material", "pa12");
await waitResult();
await shot("07-pa12");
await page.select("#material", "al6061");
await waitResult();
await page.click("#t-skel");
await shot("08-skeleton");
await page.click("#t-skel");
await page.click(".theme-toggle");
await new Promise((r) => setTimeout(r, 600));
await shot("09-light");
await page.click(".theme-toggle");
// Close-up on the camera end, where the plate and screw channels are.
await page.evaluate(() => {
  const f = window.__fixture, c = f.S.pose.center;
  f.orbit.target.set(c[0] - 0.05, c[1], c[2] - 0.08);
  f.cam3.position.set(c[0] + 0.28, c[1] - 0.42, c[2] - 0.02);
  f.orbit.update();
  f.redraw();
});
await shot("10-camera-end");

console.log("\nExport");
const obj = await page.evaluate(async () => {
  const f = window.__fixture;
  const r = await f.call("obj", { values: { ...f.S.values }, name: "camera support", lines: ["check"] });
  const head = await r.blob.slice(0, 400).text();
  return { size: r.blob.size, tris: r.metrics.triangles, pieces: r.metrics.pieces, holes: r.metrics.holesShown, head };
});
ok("OBJ: one body, in mm, with the bolt holes cut", obj.pieces === 1 && obj.holes && /units: millimetres/.test(obj.head), `${obj.tris} triangles, ${(obj.size / 1048576).toFixed(1)} MB`);

if (has("step")) {
  if (!caps.step.available) ok("STEP export available", false, caps.step.reason);
  else {
    const t = Date.now();
    const step = await page.evaluate(async () => {
      const f = window.__fixture;
      const r = await f.call("generate", { values: { ...f.S.values }, quality: "settle" });
      const res = await fetch("/api/fixture/step", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "check", solid: r.solid }) });
      if (!res.ok) return { error: (await res.json()).error, solid: r.solid };
      const body = await res.text();
      return { report: JSON.parse(res.headers.get("X-Fixture-Report")), size: body.length, head: body.slice(0, 600), meshMm3: r.metrics.volume * 1e9, feet: r.metrics.feet };
    });
    if (step.error) {
      // Keep what was sent, so the failure can be rerun against the worker alone.
      writeFileSync(join(shots, "step-failed-solid.json"), JSON.stringify(step.solid));
      ok("STEP export", false, `${step.error} · solid kept in ${join(shots, "step-failed-solid.json")}`);
    }
    else {
      ok("STEP: one solid with every bolt hole", step.report.solids === 1 && step.report.holes === 4 + 3 * step.feet, `${step.report.solids} solid, ${step.report.holes} holes for ${step.feet} feet, ${(step.size / 1048576).toFixed(1)} MB, ${((Date.now() - t) / 1000).toFixed(0)} s`);
      const schema = (step.head.match(/FILE_SCHEMA\s*\(\(\s*'([^']+)'/) ?? [])[1] ?? "unknown";
      ok("STEP is a valid ISO 10303-21 file", step.head.startsWith("ISO-10303-21;"), `schema ${schema}`);
      const diff = (step.report.volumeMm3 - step.meshMm3) / step.meshMm3;
      ok("STEP volume within 12% of the mesh (the blends are the difference)", Math.abs(diff) < 0.12, `${(diff * 100).toFixed(1)}%`);
      ok("no joins or cuts skipped by the kernel", step.report.fuseFailures === 0 && step.report.cutFailures === 0);
    }
  }
}

if (has("ai")) {
  console.log("\nAssistant");
  if (!caps.assist.available) ok("assistant available", false, caps.assist.reason);
  else {
    const massBefore = (await page.evaluate(() => window.__fixture.S.result.metrics.mass)) * 1000;
    await page.type("#ask-text", "Make it noticeably lighter. I can live with up to 0.6 mm of deflection.");
    await page.click("#btn-ask");
    await page.waitForSelector("#ask-reply .reply", { timeout: 40000 });
    await waitResult();
    const after = await page.evaluate(() => window.__fixture.S.result.metrics);
    const reply = await page.$eval("#ask-reply .reply", (el) => el.innerText.replace(/\s+/g, " ").trim());
    console.log(`        reply: ${reply}`);
    ok("the assistant changed sliders and the structure got lighter", after.mass * 1000 < massBefore, `${massBefore.toFixed(0)} g → ${(after.mass * 1000).toFixed(0)} g, deflection ${(after.deflection * 1000).toFixed(2)} mm`);
    ok("…and stayed within the limit it was given", after.deflection <= 0.6e-3 * 1.01 && after.met, `${(after.deflection * 1000).toFixed(3)} mm, target ${after.met ? "met" : "not met"}`);
    ok("the reply shows the solver's measured before and after", /Solver check/.test(reply) && /Mass .* kg/.test(reply));
    await shot("11-assistant");
    await page.click("#btn-undo");
    await waitResult();
    await page.$eval("#ask-text", (el) => { el.value = ""; });
    await page.type("#ask-text", "Move the camera 50 mm to the left.");
    await page.click("#btn-ask");
    await page.waitForFunction(() => /No controls changed/.test(document.querySelector("#ask-reply .reply")?.innerText ?? ""), { timeout: 40000 }).catch(() => {});
    const refusal = await page.$eval("#ask-reply .reply", (el) => el.innerText.replace(/\s+/g, " ").trim());
    console.log(`        reply: ${refusal}`);
    ok("asked to move the camera, it changes nothing and says so", /No controls changed/.test(refusal) && (await page.evaluate(() => JSON.stringify(window.__fixture.S.pose))) === poseLocked);
    const holderBefore = await page.evaluate(() => window.__fixture.S.values.holder);
    await page.$eval("#ask-text", (el) => { el.value = ""; });
    await page.type("#ask-text", "Hold the camera in an open cradle so it can be lifted out from above.");
    await page.click("#btn-ask");
    await page.waitForFunction(() => /Camera held by/.test(document.querySelector("#ask-reply .reply")?.innerText ?? ""), { timeout: 40000 }).catch(() => {});
    await waitResult();
    const cradled = await page.evaluate(() => ({ holder: window.__fixture.S.values.holder, select: document.getElementById("holder").value, style: window.__fixture.S.result.metrics.holder.style, pose: JSON.stringify(window.__fixture.S.pose) }));
    const cradleReply = await page.$eval("#ask-reply .reply", (el) => el.innerText.replace(/\s+/g, " ").trim());
    console.log(`        reply: ${cradleReply}`);
    ok("asked for a cradle, the assistant changes what holds the camera and nothing about where it is", holderBefore !== "cradle" && cradled.holder === "cradle" && cradled.select === "cradle" && cradled.style === "cradle" && cradled.pose === poseLocked, `${holderBefore} → ${cradled.holder}`);
    await page.click("#btn-undo");
    await waitResult();
    ok("Undo puts the holder back", await page.evaluate((h) => window.__fixture.S.values.holder === h && document.getElementById("holder").value === h, holderBefore));
  }
}

/* A setup made on a scan file is kept, and comes back when the file is
   reopened. Uses a throwaway scan so no real station's setup is touched. */
console.log("\nSaved setup");
{
  // A bench top at z = 0 and a camera-sized lump 0.5 m above it.
  const pts = [];
  for (let i = 0; i < 40000; i++) pts.push([Math.random() * 1.2 - 0.6, Math.random() * 1.2 - 0.6, (Math.random() - 0.5) * 0.002]);
  for (let i = 0; i < 2000; i++) pts.push([(Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.06, 0.5 + (Math.random() - 0.5) * 0.06]);
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`);
  const body = Buffer.alloc(pts.length * 12);
  pts.forEach((p, i) => p.forEach((v, k) => body.writeFloatLE(v, i * 12 + k * 4)));
  const scanFile = join(shots, "check-saved-setup.ply");
  writeFileSync(scanFile, Buffer.concat([head, body]));
  const query = `name=check-saved-setup.ply&count=${pts.length}`;
  const stored = async () => (await (await fetch(`${base}/api/fixture/setup?${query}`)).json()).setup;
  const open = async () => {
    await (await page.$("#file")).uploadFile(scanFile);
    await page.waitForFunction(() => window.__fixture.S.scan?.name === "check-saved-setup.ply" && window.__fixture.S.setupReady, { timeout: 20000 });
  };
  await fetch(`${base}/api/fixture/setup?${query}`, { method: "DELETE" });

  await open();
  ok("a scan with no saved setup opens empty", await page.evaluate(() => !window.__fixture.S.pose && document.getElementById("save-state").hidden));
  await page.evaluate(async () => {
    const f = window.__fixture;
    f.S.target = [0, 0, 0];
    await f.handlePick("camera", [0, 0, 0.52]);
    await f.handlePick("anchor", [0.35, 0.3, 0]);
    f.toggleLock();
    f.applyValues({ rigidity: 70 });
    f.renderAll();
  });
  await waitResult();
  await page.waitForFunction(() => /saved/.test(document.getElementById("save-state").textContent), { timeout: 10000 });
  const before = await page.evaluate(() => ({ pose: window.__fixture.S.pose, mass: window.__fixture.S.result.metrics.mass }));
  const onServer = await stored();
  ok("the setup is saved, and the page says where", /on the server and in this browser/.test(await text("save-state")) && onServer?.locked === true && onServer.anchors.length === 1, await text("save-state").then((t) => t.replace(/Start over$/, "").trim()));

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.__fixture?.S.caps, { timeout: 20000 });
  await open();
  await waitResult();
  const after = await page.evaluate(() => ({
    pose: window.__fixture.S.pose, target: window.__fixture.S.target, locked: window.__fixture.S.locked,
    anchors: window.__fixture.S.anchors.length, rigidity: window.__fixture.S.values.rigidity, mass: window.__fixture.S.result.metrics.mass,
  }));
  const moved = Math.hypot(...after.pose.center.map((v, k) => v - before.pose.center[k]));
  ok("reopening the scan brings the setup back", moved < 1e-9 && after.locked && after.anchors === 1 && after.rigidity === 70 && after.target?.[2] === 0, `camera moved ${moved} m, ${after.anchors} anchor, rigidity ${after.rigidity}`);
  ok("…and the same structure", Math.abs(after.mass - before.mass) < 1e-6, `${(before.mass * 1000).toFixed(1)} g → ${(after.mass * 1000).toFixed(1)} g`);
  ok("the page says the setup was reopened", /reopened/.test(await text("save-state")));
  await shot("12-setup-reopened");

  /* A name on the setup, and a link that opens it. */
  console.log("\nLink");
  const linkSlug = "check-saved-link";
  await fetch(`${base}/api/fixture/links/${linkSlug}`, { method: "DELETE" });
  try {
    const poseBefore = await page.evaluate(() => JSON.stringify(window.__fixture.S.pose));
    await page.evaluate(() => {
      const el = document.getElementById("link-name");
      el.value = "Check saved link";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    ok("Save as link is available once the camera is placed and named", !(await page.$eval("#btn-link-save", (el) => el.disabled || el.hidden)));
    await page.click("#btn-link-save");
    await page.waitForFunction(() => location.pathname === "/fixture/check-saved-link" && /check saved link/i.test(document.getElementById("link-list").innerText), { timeout: 10000 });
    const via = await (await fetch(`${base}/api/fixture/links/${linkSlug}`)).json();
    const storedScan = Buffer.from(await (await fetch(`${base}/api/fixture/links/${linkSlug}/scan`)).arrayBuffer());
    ok("saving gives the configuration an address", via.link?.name === "Check saved link" && via.link?.hasScan === true && via.link?.setup?.values?.rigidity === 70 && via.link?.scan?.name === "check-saved-setup.ply", via.link?.name);
    ok("the link keeps the scan", storedScan.equals(readFileSync(scanFile)));
    ok("the address is shown on the page", (await page.$eval("#link-url", (el) => el.value)).endsWith("/fixture/check-saved-link") && !(await page.$eval("#btn-link-copy", (el) => el.hidden)));
    ok("the configuration is listed, and the one on screen cannot be opened over itself", await page.$eval("#link-list", (el) => /check saved link/i.test(el.innerText) && el.querySelector('[data-link="check-saved-link"]').disabled));
    const again = await fetch(`${base}/api/fixture/links`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Check saved link", scan: via.link.scan, setup: via.link.setup }),
    });
    ok("the same name is refused rather than overwriting the link", again.status === 409);

    await page.evaluate(() => window.__fixture.applyValues({ rigidity: 55 }));
    await page.waitForFunction(async () => (await (await fetch("/api/fixture/links/check-saved-link")).json()).link?.setup?.values?.rigidity === 55, { timeout: 10000 });
    ok("a change on the page updates the link", true);

    await page.goto(`${base}/fixture/${linkSlug}`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => window.__fixture?.S.scan?.name === "check-saved-setup.ply" && window.__fixture.S.setupReady && window.__fixture.S.link?.slug === "check-saved-link" && window.__fixture.S.pose, { timeout: 20000 });
    await waitResult();
    const back = await page.evaluate((before) => {
      const pose = window.__fixture.S.pose;
      const was = JSON.parse(before);
      const off = Math.max(...["center", "view", "up"].map((k) => Math.hypot(...pose[k].map((v, i) => v - was[k][i]))));
      const state = document.getElementById("scan-state").innerText.replace(/\s+/g, " ");
      return { off, rigidity: window.__fixture.S.values.rigidity, slug: window.__fixture.S.link?.slug ?? "", empty: document.getElementById("empty").hidden, state, fromLink: Boolean(window.__fixture.S.scan.fromLink) };
    }, poseBefore);
    ok("opening the link shows the scan and the configuration, without asking for the file", back.off < 1e-9 && back.rigidity === 55 && back.slug === linkSlug && back.empty && back.fromLink && /part of the link/.test(back.state), `slug ${back.slug} · pose off ${(back.off * 1000).toFixed(3)} mm · rigidity ${back.rigidity} · ${back.state}`);

    const otherFile = join(shots, "check-link-other.ply");
    writeFileSync(otherFile, readFileSync(scanFile));
    await (await page.$("#file")).uploadFile(otherFile);
    await page.waitForFunction(() => window.__fixture.S.scan?.name === "check-link-other.ply" && window.__fixture.S.setupReady, { timeout: 20000 });
    const wrong = await page.evaluate(() => ({ pose: Boolean(window.__fixture.S.pose), link: Boolean(window.__fixture.S.link), text: document.getElementById("link-state").innerText.replace(/\s+/g, " ") }));
    ok("a different file does not take the configuration, and the page says which file the link is for", !wrong.pose && !wrong.link && /check-saved-setup\.ply/.test(wrong.text), `pose ${wrong.pose} link ${wrong.link} · ${wrong.text}`);

    await page.click("#btn-link-delete");
    const armed = await page.$eval("#btn-link-delete", (el) => el.textContent);
    await page.click("#btn-link-delete");
    await page.waitForFunction(() => /^\/fixture\/?$/.test(location.pathname), { timeout: 10000 });
    ok("Delete link asks once and then removes it", /delete\?/.test(armed) && (await fetch(`${base}/api/fixture/links/${linkSlug}`)).status === 404 && (await fetch(`${base}/api/fixture/links/${linkSlug}/scan`)).status === 404);
  } finally {
    await fetch(`${base}/api/fixture/links/${linkSlug}`, { method: "DELETE" });
  }

  await page.goto(`${base}/fixture/`, { waitUntil: "networkidle2" });
  await open();
  await waitResult();
  await page.click("#btn-forget");
  await page.waitForFunction(() => !window.__fixture.S.pose && window.__fixture.S.setupReady, { timeout: 10000 });
  ok("Start over clears it everywhere", (await stored()) === null && await page.evaluate(() => Object.keys(localStorage).every((k) => !k.startsWith("fixture.setup:check-saved-setup"))));
}

/* A ring base on a round face, on a scan that arrives upside down the way a
   Gaussian splat does. Again a throwaway scan. */
console.log("\nRing on a round face");
{
  // Z-up, metres: a floor, a round housing on it with a flange on top (a flat
  // annulus Ø 280–400 at z = 0.5), and a camera-sized lump over its inner edge,
  // high enough that the arm finder does not take the flange's rim with it.
  const F = { c: [0.1, -0.05, 0.5], rIn: 0.14, rOut: 0.2 };
  const camAt = [F.c[0] + 0.12, F.c[1], F.c[2] + 0.22];
  const pts = [];
  const rnd = Math.random;
  const round = (r, z) => { const th = rnd() * 2 * Math.PI; return [F.c[0] + r * Math.cos(th), F.c[1] + r * Math.sin(th), z]; };
  for (let i = 0; i < 60000; i++) pts.push([rnd() * 1.6 - 0.8, rnd() * 1.6 - 0.8, (rnd() - 0.5) * 0.002]);
  for (let i = 0; i < 30000; i++) pts.push(round(Math.sqrt(F.rIn ** 2 + rnd() * (F.rOut ** 2 - F.rIn ** 2)), F.c[2] + (rnd() - 0.5) * 0.003));
  for (let i = 0; i < 8000; i++) pts.push(round(F.rOut, F.c[2] - rnd() * 0.06));
  for (let i = 0; i < 8000; i++) pts.push(round(F.rIn, F.c[2] - rnd() * 0.2));
  for (let i = 0; i < 10000; i++) pts.push(round(F.rOut + rnd() * 0.1, F.c[2] - 0.06));
  for (let i = 0; i < 15000; i++) pts.push(round(0.3, rnd() * (F.c[2] - 0.06)));
  for (let i = 0; i < 2500; i++) pts.push([camAt[0] + (rnd() - 0.5) * 0.1, camAt[1] + (rnd() - 0.5) * 0.06, camAt[2] + (rnd() - 0.5) * 0.06]);
  // Written the way a splat is: Y pointing down, colour as spherical harmonics.
  const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`);
  const body = Buffer.alloc(pts.length * props.length * 4);
  pts.forEach(([x, y, z], i) => [x, -z, y, 0.4, 0.4, 0.4, 2, -5, -5, -5, 1, 0, 0, 0].forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4)));
  const scanFile = join(shots, "check-ring.ply");
  writeFileSync(scanFile, Buffer.concat([head, body]));
  const query = `name=check-ring.ply&count=${pts.length}`;
  const stored = async () => (await (await fetch(`${base}/api/fixture/setup?${query}`)).json()).setup;
  const open = async () => {
    await (await page.$("#file")).uploadFile(scanFile);
    await page.waitForFunction(() => window.__fixture.S.scan?.name === "check-ring.ply" && window.__fixture.S.setupReady, { timeout: 30000 });
  };
  await fetch(`${base}/api/fixture/setup?${query}`, { method: "DELETE" });

  await open();
  const opened = await page.evaluate(() => ({ orient: window.__fixture.S.scan.orient, floor: window.__fixture.S.scan.floor, state: document.getElementById("scan-state").innerText }));
  ok("a splat that arrives Y-down is stood the right way up, and the page says so", opened.orient === "y-" && Math.abs(opened.floor) < 0.03 && /Y-down file, turned to Z-up/.test(opened.state), `floor at ${opened.floor.toFixed(3)} m`);
  const off = await page.evaluate(() => ({ disabled: document.getElementById("s-ringWidth").disabled && document.getElementById("s-ringThickness").disabled, why: document.getElementById("w-ringWidth").title }));
  ok("ring sliders are off until there is a ring, and say why", off.disabled && /ring anchor, and none is set/.test(off.why));

  await page.evaluate(async (camAt, c) => {
    const f = window.__fixture;
    f.S.target = [c[0] - 0.02, c[1], c[2] - 0.15];
    await f.handlePick("camera", camAt);
    f.renderAll();
    // Look down on the flange from the side away from the camera.
    f.orbit.target.set(...c);
    f.cam3.position.set(c[0] - 0.5, c[1] - 0.3, c[2] + 0.9);
    f.orbit.update();
    f.redraw();
  }, camAt, F.c);
  await page.click("#btn-ring");
  await clickAt([F.c[0] - 0.17, F.c[1], F.c[2]]);
  await page.waitForFunction(() => window.__fixture.S.anchors.length === 1, { timeout: 10000 }).catch(async () => {
    await shot("13-ring-not-placed");
    console.log(`        no ring after the click: ${await page.evaluate(() => document.getElementById("anchor-state").innerText)} · mode ${await page.evaluate(() => window.__fixture.S.mode)}`);
  });
  const ring = await page.evaluate(() => ({ a: window.__fixture.S.anchors[0], list: document.getElementById("anchor-list").innerText.replace(/\s+/g, " ") }));
  const centreOff = Math.hypot(...ring.a.p.map((v, k) => v - F.c[k]));
  ok("clicking the flange finds the whole face: centre, bore and rim", ring.a.kind === "ring" && centreOff < 0.004 && Math.abs(ring.a.rIn - F.rIn) < 0.004 && Math.abs(ring.a.rOut - F.rOut) < 0.004 && ring.a.n[2] > 0.999,
    `${ring.list.replace(/ ×$/, "")} · centre ${(centreOff * 1000).toFixed(1)} mm off`);

  await page.evaluate(() => { const f = window.__fixture; f.toggleLock(); f.renderAll(); });
  await waitResult();
  let rm = await page.evaluate(() => window.__fixture.S.result.metrics);
  ok("the structure stands on a ring: one body, legs on the ring", rm.rings === 1 && rm.pieces === 1 && rm.feet === 3, `${(rm.mass * 1000).toFixed(0)} g, deflection ${(rm.deflection * 1000).toFixed(3)} mm`);
  ok("ring sliders are on once there is a ring", await page.evaluate(() => !document.getElementById("s-ringWidth").disabled && !document.getElementById("w-ringWidth").classList.contains("is-na")));
  await page.evaluate(() => window.__fixture.frame());
  await shot("13-ring");
  const light = rm.mass;
  await page.evaluate(() => window.__fixture.applyValues({ ringWidth: 100, ringThickness: 16 }));
  await waitResult();
  rm = await page.evaluate(() => window.__fixture.S.result.metrics);
  ok("a wider, thicker ring is heavier", rm.mass > light * 1.5, `${(light * 1000).toFixed(0)} g → ${(rm.mass * 1000).toFixed(0)} g`);
  await page.evaluate(() => window.__fixture.applyValues({ ringWidth: 70, ringThickness: 8 }));
  await waitResult();

  // What holds the camera. A new design wraps it; the plate is still there.
  const held = async () => page.evaluate(() => {
    const f = window.__fixture, el = document.getElementById("holder-state");
    return { asked: f.S.values.holder, h: f.S.result.metrics.holder, text: el.innerText.replace(/\s+/g, " "), warn: el.classList.contains("warn"), mount: f.S.result.mount.p, mass: f.S.result.metrics.mass, pieces: f.S.result.metrics.pieces };
  });
  const sleeve = await held();
  ok("a new design holds the camera in a sleeve, and the page says what was built",
    sleeve.asked === "sleeve" && sleeve.h.style === "sleeve" && sleeve.pieces === 1 && /Sleeve round \d+ mm of the body/.test(sleeve.text) && /connectors included, is left uncovered/.test(sleeve.text) && /150 mm straight behind it is kept empty/.test(sleeve.text),
    sleeve.text);
  ok("the connectors are outside the sleeve", sleeve.h.rearFree > 0.015, `${(sleeve.h.rearFree * 1000).toFixed(1)} mm of the body left uncovered at the back`);
  await shot("14-sleeve");
  await page.select("#holder", "cradle");
  await waitResult();
  const cradle = await held();
  await shot("14-cradle");
  await page.select("#holder", "plate");
  await waitResult();
  const plate = await held();
  const mountMoved = Math.max(...[sleeve, cradle].map((x) => Math.hypot(...x.mount.map((v, k) => v - plate.mount[k]))));
  ok("cradle and plate are the same choice, one click away, on the same camera face", cradle.h.style === "cradle" && plate.h.style === "plate" && /open above/.test(cradle.text) && /flat plate/.test(plate.text) && mountMoved < 1e-9 && cradle.pieces === 1 && plate.pieces === 1,
    `plate ${(plate.mass * 1000).toFixed(0)} g, cradle ${(cradle.mass * 1000).toFixed(0)} g, sleeve ${(sleeve.mass * 1000).toFixed(0)} g`);
  await page.select("#holder", "sleeve");
  await page.evaluate(() => window.__fixture.applyValues({ cableClearance: 0 }));
  await waitResult();
  const noRoom = await held();
  ok("with Cable room at 0 the page warns that none is kept", noRoom.h.cable === 0 && noRoom.warn && /No room is kept behind it for cables/.test(noRoom.text));
  await page.evaluate(() => window.__fixture.applyValues({ cableClearance: 150 }));
  await waitResult();
  const grip = await page.evaluate(() => ({ off: document.getElementById("s-gripLength").disabled }));
  ok("Grip length is on while the camera is wrapped", !grip.off);

  if (has("step") && caps.step.available) {
    for (const holder of ["sleeve", "cradle"]) {
      await page.evaluate((h) => window.__fixture.applyValues({ holder: h }), holder);
      await waitResult();
      const t = Date.now();
      const step = await page.evaluate(async () => {
        const f = window.__fixture;
        const r = await f.call("generate", { values: { ...f.S.values }, quality: "settle" });
        const res = await fetch("/api/fixture/step", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "check-ring", solid: r.solid }) });
        if (!res.ok) return { error: (await res.json()).error, solid: r.solid };
        return { report: JSON.parse(res.headers.get("X-Fixture-Report")), meshMm3: r.metrics.volume * 1e9, solid: r.solid };
      });
      const kept = join(shots, `step-failed-ring-${holder}.json`);
      if (step.error) {
        writeFileSync(kept, JSON.stringify(step.solid));
        ok(`STEP export with a ring and a ${holder}`, false, `${step.error} · solid kept in ${kept}`);
      } else {
        const diff = (step.report.volumeMm3 - step.meshMm3) / step.meshMm3;
        const clean = step.report.solids === 1 && step.report.rings === 1 && step.report.fuseFailures === 0 && step.report.cutFailures === 0 && Math.abs(diff) < 0.12;
        if (!clean) writeFileSync(kept, JSON.stringify(step.solid));
        ok(`STEP with a ring and a ${holder}: one solid, nothing skipped, volume within 12% of the mesh`, clean,
          `${JSON.stringify(step.report)}, ${(diff * 100).toFixed(1)}%, ${((Date.now() - t) / 1000).toFixed(0)} s`);
      }
    }
    await page.evaluate(() => window.__fixture.applyValues({ holder: "sleeve" }));
    await waitResult();
  }

  // Flip turns the scan and everything placed on it; twice is where it began.
  const before = await page.evaluate(() => ({ pose: window.__fixture.S.pose, ring: window.__fixture.S.anchors[0].p, mass: window.__fixture.S.result.metrics.mass }));
  await page.click("#btn-flip");
  await page.waitForFunction(() => window.__fixture.S.scan.orient === "y+" && window.__fixture.S.result && window.__fixture.idle(), { timeout: 30000 });
  const over = await page.evaluate(() => ({ pose: window.__fixture.S.pose, ring: window.__fixture.S.anchors[0], state: document.getElementById("scan-state").innerText }));
  const turned = (a, b) => Math.hypot(a[0] - b[0], a[1] + b[1], a[2] + b[2]);
  ok("Flip turns the scan over, and the camera and ring with it", turned(over.pose.center, before.pose.center) < 1e-9 && turned(over.ring.p, before.ring) < 1e-9 && over.ring.n[2] < -0.999 && /Y-up file, turned to Z-up/.test(over.state));
  await page.click("#btn-flip");
  await page.waitForFunction(() => window.__fixture.S.scan.orient === "y-" && window.__fixture.S.result && window.__fixture.idle(), { timeout: 30000 });
  const back = await page.evaluate(() => ({ pose: window.__fixture.S.pose, mass: window.__fixture.S.result.metrics.mass }));
  const poseOff = Math.max(...["center", "view", "up"].map((k) => Math.hypot(...back.pose[k].map((v, i) => v - before.pose[k][i]))));
  ok("flipping back restores the pose and the structure", poseOff < 1e-9 && Math.abs(back.mass - before.mass) < 1e-6, `${(before.mass * 1000).toFixed(1)} g → ${(back.mass * 1000).toFixed(1)} g`);

  await page.waitForFunction(() => /saved/.test(document.getElementById("save-state").textContent), { timeout: 10000 });
  await page.evaluate(() => window.__fixture.saveSetup());
  const kept = await stored();
  ok("the ring and which way up the scan is are saved", kept?.orient === "y-" && kept.anchors[0]?.kind === "ring" && Math.abs(kept.anchors[0].rOut - ring.a.rOut) < 1e-9);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.__fixture?.S.caps, { timeout: 20000 });
  await open();
  await waitResult();
  const again = await page.evaluate(() => ({ kind: window.__fixture.S.anchors[0]?.kind, mass: window.__fixture.S.result.metrics.mass, orient: window.__fixture.S.scan.orient }));
  ok("reopening brings the ring back, the right way up", again.kind === "ring" && again.orient === "y-" && Math.abs(again.mass - before.mass) < 1e-6, `${(again.mass * 1000).toFixed(1)} g`);

  /* Variations: several designs for the one locked camera. */
  console.log("\nVariations");
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#variants li")].map((li) => ({
    name: li.querySelector("#var-name")?.value ?? li.querySelector(".name")?.textContent, on: li.classList.contains("is-active"),
    sum: li.querySelector(".sum").textContent, removeOff: li.querySelector(".x").disabled, why: li.querySelector(".x").title,
  })));
  const saved = () => page.waitForFunction(() => /saved/.test(document.getElementById("save-state").textContent), { timeout: 10000 });
  let list = await rows();
  ok("one variation to begin with; it cannot be removed, and says why", list.length === 1 && list[0].on && list[0].removeOff && /only variation/.test(list[0].why) && /^sleeve · ring · [\d.]+ k?g · /.test(list[0].sum), list[0].sum);
  await page.click("#var-name", { clickCount: 3 });
  await page.type("#var-name", "Ring sleeve");
  const first = await page.evaluate(() => ({ mass: window.__fixture.S.result.metrics.mass, rigidity: window.__fixture.S.values.rigidity }));
  await page.click("#btn-var-new");
  await page.select("#holder", "plate");
  await page.evaluate(() => window.__fixture.applyValues({ rigidity: 30 }));
  await waitResult();
  const second = await page.evaluate(() => ({ mass: window.__fixture.S.result.metrics.mass, pose: JSON.stringify(window.__fixture.S.pose) }));
  list = await rows();
  ok("New variation keeps the one on screen and continues on a copy", list.length === 2 && list[0].name === "Ring sleeve" && !list[0].on && list[1].name === "Variation 2" && list[1].on && /^sleeve · ring/.test(list[0].sum) && /^plate · ring/.test(list[1].sum),
    list.map((r) => `${r.name}: ${r.sum}`).join(" | "));
  ok("…and both can now be removed", list.every((r) => !r.removeOff));
  await shot("15-variations");
  await page.click('#variants [data-var-open="v1"]');
  await waitResult();
  const backTo = await page.evaluate(() => ({
    holder: window.__fixture.S.values.holder, select: document.getElementById("holder").value, rigidity: window.__fixture.S.values.rigidity,
    slider: Number(document.getElementById("s-rigidity").value), mass: window.__fixture.S.result.metrics.mass, pose: JSON.stringify(window.__fixture.S.pose), style: window.__fixture.S.result.metrics.holder.style,
  }));
  ok("opening the first one brings back its holder, its values and its structure", backTo.holder === "sleeve" && backTo.select === "sleeve" && backTo.style === "sleeve" && backTo.rigidity === first.rigidity && backTo.slider === first.rigidity && Math.abs(backTo.mass - first.mass) < 1e-6,
    `${(first.mass * 1000).toFixed(1)} g → ${(backTo.mass * 1000).toFixed(1)} g, the other is ${(second.mass * 1000).toFixed(1)} g`);
  ok("the camera is where it was in both", backTo.pose === second.pose);

  // A variation can stand on something else: bolted feet on the floor instead of the ring.
  await page.evaluate(async () => {
    const f = window.__fixture;
    f.openVariation("v2");
    f.S.anchors.length = 0;
    await f.handlePick("anchor", [0.55, 0.45, 0]);
    f.renderAll();
  });
  await page.waitForFunction(() => window.__fixture.S.result && window.__fixture.idle() && window.__fixture.S.result.metrics.rings === 0, { timeout: 30000 });
  const onFloor = await page.evaluate(() => ({ rings: window.__fixture.S.result.metrics.rings, feet: window.__fixture.S.result.metrics.feet }));
  await page.click('#variants [data-var-open="v1"]');
  await page.waitForFunction(() => window.__fixture.S.result && window.__fixture.idle() && window.__fixture.S.result.metrics.rings === 1, { timeout: 30000 });
  const onRing = await page.evaluate(() => ({ kind: window.__fixture.S.anchors[0]?.kind, n: window.__fixture.S.anchors.length, mass: window.__fixture.S.result.metrics.mass }));
  list = await rows();
  ok("each variation keeps its own anchors", onFloor.rings === 0 && onFloor.feet >= 2 && onRing.kind === "ring" && onRing.n === 1 && Math.abs(onRing.mass - first.mass) < 1e-6 && /1 anchor/.test(list[1].sum), list.map((r) => `${r.name}: ${r.sum}`).join(" | "));

  await page.evaluate(() => window.__fixture.saveSetup());
  await saved();
  let onDisk = await stored();
  ok("all variations are saved, and which one is on screen", onDisk?.variations?.length === 2 && onDisk.active === "v1" && onDisk.variations[0].name === "Ring sleeve" && onDisk.variations[0].values.holder === "sleeve" && onDisk.variations[1].values.holder === "plate" && onDisk.variations[1].anchors[0].kind !== "ring" && onDisk.rev >= 1, `revision ${onDisk?.rev}`);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.__fixture?.S.caps, { timeout: 20000 });
  await open();
  await waitResult();
  list = await rows();
  const reopened = await page.evaluate(() => ({ mass: window.__fixture.S.result.metrics.mass, state: document.getElementById("save-state").innerText }));
  ok("reopening the scan brings every variation back", list.length === 2 && list[0].name === "Ring sleeve" && list[0].on && list[1].name === "Variation 2" && Math.abs(reopened.mass - first.mass) < 1e-6 && /2 variations/.test(reopened.state));

  // Two clicks to remove, so a slip of the mouse does not lose a design.
  await page.click('#variants [data-var-remove="v2"]');
  const armed = await page.evaluate(() => ({ n: window.__fixture.S.variations.length, label: document.querySelector('#variants [data-var-remove="v2"]').textContent }));
  await page.click('#variants [data-var-remove="v2"]');
  list = await rows();
  ok("removing a variation takes two clicks", armed.n === 2 && /remove\?/.test(armed.label) && list.length === 1 && list[0].name === "Ring sleeve" && list[0].removeOff);

  /* A page left open cannot overwrite work saved elsewhere since. */
  await page.evaluate(() => window.__fixture.saveSetup());
  await page.waitForFunction(async (q) => (await (await fetch(`/api/fixture/setup?${q}`)).json()).setup?.variations?.length === 1, { timeout: 10000 }, query);
  onDisk = await stored();
  const { savedAt: _at, rev, ...theirs } = onDisk;
  theirs.variations[0].name = "From another tab";
  const elsewhere = await fetch(`${base}/api/fixture/setup`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scan: { name: "check-ring.ply", count: pts.length }, base: rev, setup: theirs }) });
  const stale = await fetch(`${base}/api/fixture/setup`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scan: { name: "check-ring.ply", count: pts.length }, base: rev, setup: theirs }) });
  ok("the server takes a write based on the current revision and refuses one based on an older", elsewhere.status === 200 && stale.status === 409, `${elsewhere.status}, then ${stale.status}`);
  await page.evaluate(() => window.__fixture.applyValues({ rigidity: 40 }));
  await page.waitForSelector("#btn-reload-setup", { timeout: 10000 });
  const refused = await page.evaluate(() => ({ text: document.getElementById("save-state").innerText, warn: document.getElementById("save-state").classList.contains("warn") }));
  onDisk = await stored();
  ok("a stale page is told its change was not saved, and the newer work is intact", refused.warn && /changed in another tab or session/.test(refused.text) && onDisk.variations[0].name === "From another tab" && onDisk.rev === rev + 1);
  await page.click("#btn-reload-setup");
  await page.waitForFunction(() => window.__fixture.S.setupReady && window.__fixture.S.pose && window.__fixture.S.variations[0].name === "From another tab", { timeout: 30000 });
  await waitResult();
  await page.evaluate(() => window.__fixture.applyValues({ rigidity: 45 }));
  await page.waitForFunction(async (q) => (await (await fetch(`/api/fixture/setup?${q}`)).json()).setup?.values?.rigidity === 45, { timeout: 10000 }, query);
  ok("Load the newer version shows it, and saving works again", (await stored()).rev === rev + 2 && await page.evaluate(() => !window.__fixture.S.conflict && !document.getElementById("btn-reload-setup")));
  // The refused write is the one failed request this check expects.
  for (let i = errors.length - 1; i >= 0; i--) if (/status of 409/.test(errors[i])) errors.splice(i, 1);

  /* A setup saved before holders and variations existed opens as the design
     it was: one variation, on a plate, with no room cut for cables. */
  onDisk = await stored();
  const { savedAt: _at2, rev: _rev, variations: _v, active: _a, ...old } = onDisk;
  old.values = Object.fromEntries(Object.entries(old.values).filter(([k]) => !["holder", "cableClearance", "gripLength"].includes(k)));
  await fetch(`${base}/api/fixture/setup?${query}`, { method: "DELETE" });
  const legacyPut = await fetch(`${base}/api/fixture/setup`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scan: { name: "check-ring.ply", count: pts.length }, setup: old }) });
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fixture.setup:check-ring")).forEach((k) => localStorage.removeItem(k)));
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.__fixture?.S.caps, { timeout: 20000 });
  await open();
  await waitResult();
  const legacy = await page.evaluate(() => {
    const f = window.__fixture;
    return { n: f.S.variations.length, name: f.S.variations[0].name, holder: f.S.values.holder, cable: f.S.values.cableClearance, h: f.S.result.metrics.holder, kind: f.S.anchors[0]?.kind };
  });
  ok("a setup from before holders existed opens as it was drawn: one variation, on a plate", legacyPut.status === 200 && legacy.n === 1 && legacy.holder === "plate" && legacy.cable === 0 && legacy.h.style === "plate" && legacy.h.cable === 0 && legacy.kind === "ring", `${legacy.name}: ${legacy.h.style}, cable room ${legacy.cable}`);
  await new Promise((r) => setTimeout(r, 1500));
  ok("…and opening it does not rewrite it", (await stored()).rev === 1 && !(await stored()).variations);
  await page.click("#btn-var-new");
  await page.select("#holder", "sleeve");
  await page.evaluate(() => window.__fixture.applyValues({ cableClearance: 150 }));
  await waitResult();
  await page.evaluate(() => window.__fixture.saveSetup());
  await page.waitForFunction(async (q) => (await (await fetch(`/api/fixture/setup?${q}`)).json()).setup?.variations?.length === 2, { timeout: 10000 }, query);
  onDisk = await stored();
  ok("a sleeve tried on a copy leaves the old design as it was", onDisk.variations[0].values.holder === "plate" && onDisk.variations[0].values.cableClearance === 0 && onDisk.variations[1].values.holder === "sleeve" && onDisk.active === "v2");

  /* A tab from before variations, left open and changed after the server's
     copy gained some: on reload its design joins them, and none is lost. */
  await page.evaluate((key, stray) => localStorage.setItem(key, JSON.stringify(stray)), `fixture.setup:check-ring.ply:${pts.length}`,
    { ...old, values: { ...old.values, rigidity: 20 }, savedAt: new Date(Date.now() + 60e3).toISOString() });
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.__fixture?.S.caps, { timeout: 20000 });
  await open();
  await waitResult();
  await page.waitForFunction(async (q) => (await (await fetch(`/api/fixture/setup?${q}`)).json()).setup?.variations?.length === 3, { timeout: 10000 }, query).catch(() => {});
  onDisk = await stored();
  list = await rows();
  ok("a design left in an old tab joins the saved variations instead of replacing them",
    onDisk.variations.length === 3 && onDisk.variations[0].values.holder === "plate" && onDisk.variations[1].values.holder === "sleeve" && onDisk.variations[2].values.rigidity === 20 && onDisk.variations[2].values.holder === "plate" && /^From this browser/.test(list[2]?.name ?? "") && list[2].on,
    list.map((r) => r.name).join(" | "));

  await page.click("#btn-forget");
  await page.waitForFunction(() => !window.__fixture.S.pose && window.__fixture.S.setupReady, { timeout: 10000 });
  ok("Start over clears the ring setup", (await stored()) === null);
}

writeFileSync(join(shots, "errors.txt"), errors.join("\n"));
ok("no script errors on the page", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed · screenshots in ${shots}`);
process.exit(fail ? 1 : 0);
