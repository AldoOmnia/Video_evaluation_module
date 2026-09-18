/**
 * Shoot every platform page in both themes, so light-mode regressions are
 * visible side by side. Also reports low-contrast text it can detect, which is
 * the failure mode that hardcoded colours cause when the palette flips.
 *
 *   node tools/_shot-themes.mjs [baseUrl] [pageFilter]
 */
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] || "http://localhost:3001";
const only = process.argv[3];

const PAGES = [
  ["login", "/login"],
  ["home", "/home"],
  ["welcome", "/welcome"],
  ["knowledge", "/knowledge"],
  ["reports", "/reports"],
  ["settings", "/settings"],
  ["twin", "/synthetic-pov"],
].filter(([n]) => !only || n === only);

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

/* Seed the session blob the pages self-gate on, rather than driving the login
   form — the form needs the auth endpoint up, and these shots only care about
   how the chrome paints. Shape matches what login.html stores. */
const SESSION = JSON.stringify({
  tenant: "comer",
  token: "dev-screenshot",
  user: { email: "admin@comer.com", name: "Comer Admin", role: "admin" },
  expiresAt: Date.now() + 8 * 3600 * 1000,
});

/** Relative luminance per WCAG, from an rgb()/rgba() string. */
const LUM = `(c) => {
  const m = c.match(/[\\d.]+/g); if (!m) return null;
  const [r, g, b] = m.slice(0, 3).map(Number);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}`;

for (const theme of ["dark", "light"]) {
  for (const [name, path] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument(
      (t, s) => {
        localStorage.setItem("daedalus.theme", t);
        localStorage.setItem("omnia.introSeen", "1");
        localStorage.setItem("omnia.session", s);
      },
      theme,
      SESSION,
    );
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, name === "twin" ? 7000 : 3000));
    await page.screenshot({ path: join(root, `tools/_theme-${name}-${theme}.png`) });

    // Any visible text whose colour is within 2.2:1 of what it sits on.
    const bad = await page.evaluate((lumSrc) => {
      const lum = eval(lumSrc);
      const ratio = (a, b) => {
        const [hi, lo] = a > b ? [a, b] : [b, a];
        return (hi + 0.05) / (lo + 0.05);
      };
      const bgOf = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
        }
        return "rgb(255,255,255)";
      };
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
        const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
        if (!txt) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || Number(cs.opacity) < 0.15) continue;
        const f = lum(cs.color), b = lum(bgOf(el));
        if (f == null || b == null) continue;
        const r = ratio(f, b);
        if (r < 2.2) out.push({ txt: txt.slice(0, 38), color: cs.color, bg: bgOf(el), ratio: +r.toFixed(2) });
      }
      /* SVG paints with fill/stroke, not color, so the loop above cannot see
         the maps and graphs at all — that is where white-on-white hides. */
      const svgBg = (el) => {
        const host = el.closest("svg")?.parentElement;
        return host ? bgOf(host) : "rgb(255,255,255)";
      };
      for (const el of document.querySelectorAll("svg text, svg circle, svg line, svg path")) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || Number(cs.opacity) < 0.15) continue;
        const b = lum(svgBg(el));
        for (const prop of ["fill", "stroke"]) {
          const v = cs[prop];
          if (!v || v === "none") continue;
          const f = lum(v);
          if (f == null || b == null) continue;
          const r = ratio(f, b);
          if (r < 1.35) {
            out.push({
              txt: `<${el.tagName} ${prop}>` + (el.textContent || "").trim().slice(0, 22),
              color: v, bg: svgBg(el), ratio: +r.toFixed(2),
            });
          }
        }
      }
      return out.slice(0, 14);
    }, LUM);

    console.log(
      `${theme.padEnd(5)} ${name.padEnd(10)} low-contrast:${String(bad.length).padStart(2)}` +
        (bad.length ? "\n" + bad.map((b) => `      ${b.ratio}  "${b.txt}"  ${b.color} on ${b.bg}`).join("\n") : ""),
    );
    await page.close();
  }
}
await browser.close();
