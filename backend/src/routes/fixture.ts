/**
 * /api/fixture — server side of the camera-support generator (/fixture/).
 *
 * The structure itself is generated in the browser. The server does the three
 * things a browser cannot or should not:
 *
 *   GET  /api/fixture/capabilities  what this host can do, with a reason for
 *                                   each thing it cannot
 *   POST /api/fixture/assist        a typed request → slider values (Claude)
 *   POST /api/fixture/locate        renders of the scan → where the camera and
 *                                   its target are in each (Gemini vision)
 *   POST /api/fixture/step          the solid description → a STEP file
 *   GET | PUT | DELETE /api/fixture/setup
 *                                   what was decided about one scan — camera
 *                                   pose, target, anchors, slider values — so
 *                                   it survives a reload and another browser
 *   GET | POST | PUT | DELETE /api/fixture/links
 *                                   the same, under a name, opened by
 *                                   /fixture/<name>
 *
 * Nothing here stores the scan. Locate receives rendered views, not points;
 * step receives the generated structure only; a saved setup is a few hundred
 * numbers, keyed by the scan's file name and point count.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { config, stubMode } from "../config.js";
import { REPO_ROOT, SHARED_DIR } from "../paths.js";
import { llmCall } from "../services/anthropic.js";
import { geminiConfigured, geminiVisionCall, VISION_MODEL, type GeminiPart } from "../services/gemini.js";
import { buildStep, StepBusyError, stepCapability } from "../services/fixtureStep.js";

export const fixtureRouter = Router();

/* ── Slider schema — the same file the page builds its controls from ─────── */

interface SliderSpec {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
  help: string;
}
interface ParamSchema {
  sliders: SliderSpec[];
  materials: Array<{ id: string; label: string }>;
  holders?: Array<{ id: string; label: string; help: string }>;
}

const SCHEMA_PATH = join(SHARED_DIR, "data", "fixture-params.json");
/** Read per request: the file is small, and an edit should not need a restart. */
const loadSchema = (): ParamSchema => JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as ParamSchema;

/** Keep only known sliders, snapped to their step and clamped to their range. */
function clampPatch(raw: unknown, schema: ParamSchema): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const s of schema.sliders) {
    const v = Number((raw as Record<string, unknown>)[s.id]);
    if (!Number.isFinite(v)) continue;
    const snapped = s.min + Math.round((v - s.min) / s.step) * s.step;
    out[s.id] = Math.min(s.max, Math.max(s.min, Number(snapped.toFixed(6))));
  }
  return out;
}

/** First JSON object in a model reply, tolerating code fences and preamble. */
function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const startArr = text.indexOf("[");
  const from = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
  if (from < 0) return null;
  const open = text[from];
  const close = open === "{" ? "}" : "]";
  const to = text.lastIndexOf(close);
  if (to <= from) return null;
  try {
    return JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
}

/* ── Capabilities ─────────────────────────────────────────────────────────── */

fixtureRouter.get("/capabilities", (_req, res) => {
  const step = stepCapability();
  res.json({
    ok: true,
    assist: stubMode
      ? { available: false, reason: "the assistant needs ANTHROPIC_API_KEY set on the server" }
      : { available: true, reason: "", model: config.anthropicModel },
    locate: geminiConfigured()
      ? { available: true, reason: "", model: VISION_MODEL }
      : { available: false, reason: "auto-locate needs GEMINI_API_KEY set on the server" },
    step,
  });
});

/* ── Assistant: typed request → slider values ─────────────────────────────── */

const AssistBody = z.object({
  request: z.string().trim().min(2).max(600),
  values: z.record(z.union([z.number(), z.string()])),
  metrics: z.record(z.unknown()).optional(),
  context: z.record(z.unknown()).optional(),
  /** Solver results the page measured before asking — never model output. */
  whatIf: z.record(z.unknown()).optional(),
  /** Earlier proposals for this same request, each with its measured result. */
  trials: z
    .array(z.object({ set: z.record(z.number()), material: z.string().optional(), holder: z.string().optional(), measured: z.record(z.unknown()), missed: z.array(z.string()) }))
    .max(4)
    .optional(),
  lang: z.enum(["en", "it"]).optional(),
});

/** The limits an engineer can state that the solver actually measures. */
const LIMIT_IDS = ["max_deflection_mm", "max_mass_g", "max_tilt_mrad", "min_first_mode_hz"] as const;
function readLimits(raw: unknown): Partial<Record<(typeof LIMIT_IDS)[number], number>> {
  const out: Partial<Record<(typeof LIMIT_IDS)[number], number>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of LIMIT_IDS) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[id] = v;
  }
  return out;
}

fixtureRouter.post("/assist", async (req, res, next) => {
  try {
    const body = AssistBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "send a request and the current slider values" });
      return;
    }
    if (stubMode) {
      res.status(503).json({ ok: false, error: "the assistant needs ANTHROPIC_API_KEY set on the server" });
      return;
    }
    const schema = loadSchema();
    const { request, values, metrics, context, whatIf, trials, lang } = body.data;

    const controls = schema.sliders
      .map((s) => `- ${s.id} (${s.label}${s.unit ? `, ${s.unit}` : ""}): ${s.min} to ${s.max}, step ${s.step}. ${s.help}`)
      .join("\n");
    const materials = schema.materials.map((m) => `${m.id} (${m.label})`).join(", ");
    const holders = (schema.holders ?? []).map((h) => `${h.id} (${h.label}: ${h.help})`).join("; ");

    const system = `You set the controls of a generative-design tool that produces a support structure holding an industrial vision camera in a fixed position. The camera pose and the anchor points are already fixed by the engineer and are NOT yours to change. You only choose slider values, the material and what holds the camera.

Controls:
${controls}
- material: one of ${materials}
- holder (what grips the camera): one of ${holders}

How the tool behaves, so your choices are grounded:
- Struts are sized automatically so that the camera's deflection under 1 g just meets the rigidity target; you do not set strut thickness directly, only its minimum and maximum.
- The rigidity control IS the deflection target: target_mm = 2 × 10^(−rigidity/50). So 0 → 2 mm, 25 → 0.63 mm, 50 → 0.2 mm, 75 → 0.063 mm, 100 → 0.02 mm. To allow a deflection of D mm, rigidity = 50 × log10(2 / D), rounded UP to the next step so the result stays under D.
- Stiffer (higher rigidity) always costs mass. If the result shows "met": false the struts have hit maxDiameter and the target is not being reached: raise maxDiameter, or pick a stiffer material, or lower rigidity if the request allows it.
- Lowering minDiameter or maxDiameter does not save mass by itself; the solver already uses the thinnest struts that meet the target. Lowering maxDiameter can only make a target unreachable.
- More feet, a wider base spread and cross ties add torsional stiffness for little mass. Removing feet or ties therefore rarely saves mass: the struts that remain must grow to meet the same target. To make the part lighter, the controls that work are rigidity (if the engineer allows more deflection) and material.
- Clearance keeps the structure away from the scanned surroundings and out of the camera's field of view.
- The holder does not move the camera: plate, cradle and sleeve sit on the same four screws. In every one of them the screws are what holds the camera along its own axis; the walls of a cradle or sleeve hold it sideways. None of them covers the connectors at the back. cableClearance is the room kept empty straight behind the connectors; the camera's maker asks for 150 mm.
- "metrics" are the solver's results for the CURRENT values. "whatIf" holds solver results for the same settings in each material. "trials" are your earlier proposals for this request with the solver's measured result and what they missed. These three are the only measurements you have.

Reply with ONE JSON object and nothing else:
{"set": {"<slider id>": <number>, ...}, "material": "<id or omit>", "holder": "<id or omit>", "limits": {"max_deflection_mm": <number>, "max_mass_g": <number>, "max_tilt_mrad": <number>, "min_first_mode_hz": <number>}, "why": "<two sentences at most>"}

Rules:
- Include in "set" only the controls you are changing. Stay inside each range.
- Change as few controls as the request needs. Do not reset things the engineer did not mention.
- "limits": include only the numeric limits the engineer stated in the request, converted to these units; omit the key otherwise. Your proposal will be measured by the solver against them before it is applied.
- If "trials" is not empty, your last proposal missed something. Revise it using the measured numbers; do not repeat a proposal that already failed. If the limits cannot all be met with these controls, propose the closest you can and say which limit is missed.
- If the request asks for something these controls cannot do (move the camera, change the anchors, add a feature, guarantee a number the tool does not compute), set nothing and say so in "why".
- Never invent a measurement and never predict one. In "why", describe what you changed and the reason; the page prints the solver's measured before and after next to your answer. If you quote a number it must appear in "metrics", "whatIf", "trials" or a control's range. Do not use the words "metrics", "whatIf" or "trials" in "why"; say "measured" instead.
- Write "why" in ${lang === "it" ? "Italian" : "English"}, plainly, as an engineer would. No emoji.`;

    const user = `Current values: ${JSON.stringify(values)}
Metrics for those values: ${JSON.stringify(metrics ?? {})}
whatIf: ${JSON.stringify(whatIf ?? {})}
trials: ${JSON.stringify(trials ?? [])}
Setup: ${JSON.stringify(context ?? {})}

Request: ${request}`;

    const out = await llmCall({ system, user, maxTokens: 500, route: "fixture-assist" });
    const parsed = firstJson(out.text) as { set?: unknown; material?: unknown; holder?: unknown; why?: unknown } | null;
    if (!parsed || typeof parsed !== "object") {
      res.status(502).json({ ok: false, error: "the assistant's reply could not be read — try rephrasing" });
      return;
    }
    const set = clampPatch(parsed.set, schema);
    // Drop no-ops so the page can say truthfully what changed.
    for (const [id, v] of Object.entries(set)) if (Number(values[id]) === v) delete set[id];
    const material =
      typeof parsed.material === "string" && schema.materials.some((m) => m.id === parsed.material) && parsed.material !== values.material
        ? parsed.material
        : undefined;
    const holder =
      typeof parsed.holder === "string" && (schema.holders ?? []).some((h) => h.id === parsed.holder) && parsed.holder !== values.holder
        ? parsed.holder
        : undefined;
    res.json({
      ok: true,
      set,
      material,
      holder,
      limits: readLimits((parsed as { limits?: unknown }).limits),
      why: typeof parsed.why === "string" ? parsed.why.slice(0, 600) : "",
      model: config.anthropicModel,
      latencyMs: out.latencyMs,
    });
  } catch (err) {
    next(err);
  }
});

/* ── Auto-locate: rendered views → camera and target in each ──────────────── */

const LocateBody = z.object({
  views: z
    .array(
      z.object({
        name: z.string().max(40),
        /** JPEG, base64, no data: prefix. */
        image: z.string().min(100).max(3_000_000),
      }),
    )
    .min(1)
    .max(4),
});

interface LocatedView {
  view: string;
  camera: [number, number] | null;
  target: [number, number] | null;
  confidence: number;
  note: string;
}

/** A point as the model returns it — [y, x] on a 0–1000 grid — to [x, y] in 0–1. */
function toXY(p: unknown): [number, number] | null {
  if (!Array.isArray(p) || p.length < 2) return null;
  const y = Number(p[0]);
  const x = Number(p[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > 1000 || y > 1000) return null;
  return [x / 1000, y / 1000];
}

fixtureRouter.post("/locate", async (req, res, next) => {
  try {
    const body = LocateBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "send one to four rendered views of the scan" });
      return;
    }
    if (!geminiConfigured()) {
      res.status(503).json({ ok: false, error: "auto-locate needs GEMINI_API_KEY set on the server" });
      return;
    }
    const { views } = body.data;
    const parts: GeminiPart[] = [
      {
        text: `These ${views.length} images are renders of ONE LiDAR point-cloud scan of a factory inspection station, each from a different viewpoint. Point clouds look grainy and have gaps; that is normal.

In the scene an industrial machine-vision camera — a small dark block roughly 10 cm long — is held in the air by a temporary stand or arm, aimed at a part on a bench or fixture.

For EACH image, find:
- "camera": the camera body itself, at the end of the arm (not the stand's base or column).
- "target": the part the camera is aimed at.

Reply with ONE JSON array and nothing else, one object per image in the order given:
[{"view": "<name>", "camera": [y, x] or null, "target": [y, x] or null, "confidence": <0 to 1>, "note": "<short reason>"}]

Points are [y, x], each from 0 to 1000, measured from the top-left of that image.
Use null when you cannot see the thing in that view. Do not guess: a null is more useful than a wrong point. Set confidence low when the camera is not clearly distinguishable from the arm.`,
      },
    ];
    for (const v of views) {
      parts.push({ text: `Image "${v.name}":` });
      parts.push({ inline_data: { mime_type: "image/jpeg", data: v.image } });
    }
    const out = await geminiVisionCall(parts, { route: "fixture-locate", maxOutputTokens: 700, timeoutMs: 40_000 });
    const parsed = firstJson(out.text);
    if (!Array.isArray(parsed)) {
      res.status(502).json({ ok: false, error: "the vision model's reply could not be read" });
      return;
    }
    const located: LocatedView[] = views.map((v, i) => {
      const hit =
        (parsed as Array<Record<string, unknown>>).find((p) => p && p.view === v.name) ??
        (parsed as Array<Record<string, unknown>>)[i] ??
        {};
      const conf = Number(hit.confidence);
      return {
        view: v.name,
        camera: toXY(hit.camera),
        target: toXY(hit.target),
        confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
        note: typeof hit.note === "string" ? hit.note.slice(0, 200) : "",
      };
    });
    res.json({ ok: true, views: located, model: out.model, latencyMs: out.latencyMs });
  } catch (err) {
    next(err);
  }
});

/* ── STEP export ──────────────────────────────────────────────────────────── */

const num = z.number().finite();
const vec3 = z.tuple([num.min(-200).max(200), num.min(-200).max(200), num.min(-200).max(200)]);
const radius = num.min(0.0003).max(0.5);
const length = num.min(0.0005).max(2);

const SolidBody = z.object({
  name: z.string().trim().max(80).optional(),
  solid: z.object({
    units: z.literal("m"),
    cones: z.array(z.object({ a: vec3, b: vec3, ra: radius, rb: radius, id: z.number().int().min(0).max(999) })).min(1).max(400),
    boxes: z.array(z.object({ c: vec3, u: vec3, v: vec3, n: vec3, half: z.tuple([length, length, length]) }).passthrough()).max(4).optional(),
    discs: z.array(z.object({ c: vec3, n: vec3, r: radius, h: length }).passthrough()).max(16).optional(),
    rings: z.array(z.object({ c: vec3, n: vec3, R: num.min(0.01).max(1), half: num.min(0.002).max(0.5), h: length }).passthrough()).max(4).optional(),
    cutCyls: z.array(z.object({ c: vec3, n: vec3, r: radius, h: length, role: z.string().max(40).optional() })).max(200).optional(),
    cutBoxes: z.array(z.object({ c: vec3, u: vec3, v: vec3, n: vec3, half: z.tuple([length, length, length]) }).passthrough()).max(8).optional(),
    cutPlanes: z.array(z.object({ p: vec3, n: vec3, r: num.min(0.0003).max(1.5) })).max(16).optional(),
  }).passthrough(),
});

fixtureRouter.post("/step", async (req, res, next) => {
  try {
    const cap = stepCapability();
    if (!cap.available) {
      res.status(503).json({ ok: false, error: cap.reason });
      return;
    }
    const body = SolidBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "the structure description is not valid — regenerate and try again" });
      return;
    }
    const { bytes, report } = await buildStep(body.data.solid);
    if (report.solids !== 1 || report.fuseFailures > 0 || report.cutFailures > 0) {
      // A file with loose pieces, or with a member or a hole left out, would
      // import into NX looking fine and fail later. Refuse it and say what
      // happened.
      const what =
        report.solids !== 1
          ? `the CAD kernel produced ${report.solids} bodies instead of one (${report.fuseFailures} joins failed)`
          : report.fuseFailures > 0
            ? `the CAD kernel left out ${report.fuseFailures} part${report.fuseFailures === 1 ? "" : "s"} of the structure`
            : `the CAD kernel could not make ${report.cutFailures} of the cuts (holes or the camera's recess)`;
      res.status(422).json({ ok: false, error: `${what} — change the layout slightly and export again`, report });
      return;
    }
    const file = (body.data.name || "camera-support").replace(/[^\w.-]+/g, "_").slice(0, 60);
    res.set({
      "Content-Type": "model/step",
      "Content-Disposition": `attachment; filename="${file}.step"`,
      "X-Fixture-Report": JSON.stringify(report),
      "Access-Control-Expose-Headers": "X-Fixture-Report",
      "Cache-Control": "no-store",
    });
    res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (err) {
    if (err instanceof StepBusyError) {
      res.status(429).json({ ok: false, error: err.message });
      return;
    }
    next(err);
  }
});

/* ── Saved setups ───────────────────────────────────────────────────────────
   One JSON file per scan under backend/.fixture-setups/ (gitignored: the
   coordinates describe a client's station), or under FIXTURE_SETUP_ROOT. A
   deploy replaces the checkout, so a hosted service points that at a mounted
   disk; without one the files last until the next deploy and the browser
   keeps its own copy. */

const SETUP_DIR = process.env.FIXTURE_SETUP_ROOT?.trim() || join(REPO_ROOT, "backend", ".fixture-setups");

const ScanRef = z.object({
  name: z.string().min(1).max(200),
  count: z.coerce.number().int().positive().max(1e9),
});
const unit3 = z.array(z.number().finite().min(-1.001).max(1.001)).length(3);
const SetupAnchors = z.array(z.object({
  p: vec3, n: unit3,
  rms: z.number().finite().nullable(), flat: z.boolean(), count: z.number().int().min(0),
  // A ring anchor: the flat round face it sits on.
  kind: z.enum(["point", "ring"]).optional(),
  rIn: z.number().finite().min(0).max(1).optional(),
  rOut: z.number().finite().min(0).max(1).optional(),
  coverage: z.number().finite().min(0).max(1).optional(),
})).max(4);
const SetupValues = z.record(z.string().max(40), z.union([z.number().finite(), z.string().max(40)]));
const SetupBody = z.object({
  scan: ScanRef,
  // The revision this write is based on; see PUT /setup.
  base: z.number().int().min(0).optional(),
  setup: z.object({
    pose: z.object({ center: vec3, view: unit3, up: unit3 }),
    target: vec3.nullable(),
    locked: z.boolean(),
    anchors: SetupAnchors,
    // Alternative designs for the same pose. `anchors` and `values` above are
    // the active one's, kept at the top level as well.
    variations: z.array(z.object({
      id: z.string().min(1).max(20),
      name: z.string().min(1).max(40),
      values: SetupValues,
      anchors: SetupAnchors,
      summary: z.object({ mass: z.number().finite(), deflection: z.number().finite(), met: z.boolean() }).nullable().optional(),
    })).min(1).max(12).optional(),
    active: z.string().max(20).optional(),
    camera: z.object({
      model: z.string().max(60), lens: z.string().max(20), face: z.string().max(20),
      l: z.number().finite(), w: z.number().finite(), h: z.number().finite(),
      hu: z.number().finite(), hv: z.number().finite(), mass: z.number().finite(),
    }),
    // Which way up the scan was when these coordinates were taken, e.g. "y-".
    orient: z.string().regex(/^[yz][+-]$/).optional(),
    values: SetupValues,
    reach: z.number().finite(),
    brushes: z.array(z.object({
      center: vec3, radius: z.number().finite().positive().max(1), value: z.union([z.literal(0), z.literal(1)]),
    })).max(400),
  }),
});

/** The file for one scan. The name is the user's; only its hash touches the disk. */
function setupFile(scan: z.infer<typeof ScanRef>): string {
  const key = createHash("sha256").update(`${scan.name}\n${scan.count}`).digest("hex").slice(0, 24);
  return join(SETUP_DIR, `${key}.json`);
}

fixtureRouter.get("/setup", (req, res) => {
  const scan = ScanRef.safeParse(req.query);
  if (!scan.success) return res.status(400).json({ ok: false, error: "name and count of the scan are required" });
  const file = setupFile(scan.data);
  if (!existsSync(file)) return res.json({ ok: true, setup: null });
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { savedAt: string; rev?: number; setup: object };
    res.json({ ok: true, setup: { savedAt: saved.savedAt, rev: saved.rev ?? 0, ...saved.setup } });
  } catch {
    // A half-written or hand-edited file is no setup, not a failure of the page.
    res.json({ ok: true, setup: null });
  }
});

fixtureRouter.put("/setup", (req, res) => {
  const body = SetupBody.safeParse(req.body);
  if (!body.success) {
    const issue = body.error.issues[0];
    return res.status(400).json({ ok: false, error: `setup not saved: ${issue.path.join(".")} ${issue.message}` });
  }
  mkdirSync(SETUP_DIR, { recursive: true });
  const file = setupFile(body.data.scan);
  // Every write bumps the revision, and a write has to name the revision it
  // started from. A page left open while the setup was changed elsewhere is
  // told so instead of silently replacing the newer work.
  let rev = 0;
  if (existsSync(file)) {
    let had: { rev?: number; setup?: { variations?: unknown } } = {};
    try {
      had = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // unreadable: anything may replace it
    }
    rev = had.rev ?? 0;
    // A page loaded before revisions existed names none. It also knows nothing
    // of variations, so it may go on saving only while there are none to lose.
    const stale = body.data.base === undefined ? Array.isArray(had.setup?.variations) : body.data.base !== rev;
    if (stale) {
      return res.status(409).json({ ok: false, rev, error: "setup not saved: it was changed elsewhere after this page opened it — reload to continue from that version" });
    }
  }
  rev += 1;
  const savedAt = new Date().toISOString();
  // Written beside and renamed, so a reader never sees half a file.
  writeFileSync(`${file}.tmp`, JSON.stringify({ scan: body.data.scan, savedAt, rev, setup: body.data.setup }, null, 1));
  renameSync(`${file}.tmp`, file);
  res.json({ ok: true, savedAt, rev });
});

fixtureRouter.delete("/setup", (req, res) => {
  const scan = ScanRef.safeParse(req.query);
  if (!scan.success) return res.status(400).json({ ok: false, error: "name and count of the scan are required" });
  rmSync(setupFile(scan.data), { force: true });
  res.json({ ok: true });
});

/* ── Named configurations ───────────────────────────────────────────────────
   A setup under a name, so /fixture/<slug> opens it. The scan file is not
   stored: the link remembers which file, and whoever opens it picks that
   file from their own disk. Slugs are the name folded to lowercase words,
   and they never change, so a link that has been sent keeps working when
   the configuration is renamed. */

const SHARE_DIR = join(SETUP_DIR, "shares");
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ShareWrite = z.object({
  name: z.string().trim().min(1).max(80),
  scan: ScanRef,
  setup: SetupBody.shape.setup,
  base: z.number().int().min(0).optional(),
});

/** The address form of a name: "Comer cognex camera 2800" → comer-cognex-camera-2800. */
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sharePath(slug: string): string | null {
  if (!SLUG.test(slug) || slug.length > 60) return null;
  return join(SHARE_DIR, `${slug}.json`);
}

interface ShareRecord {
  slug: string;
  name: string;
  savedAt: string;
  rev: number;
  scan: z.infer<typeof ScanRef>;
  setup: unknown;
}

function readShare(file: string): ShareRecord | null {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as ShareRecord;
    if (!d || typeof d.slug !== "string" || !d.setup) return null;
    return d;
  } catch {
    return null;
  }
}

const ShareCreate = ShareWrite.omit({ base: true });

fixtureRouter.get("/links", (_req, res) => {
  if (!existsSync(SHARE_DIR)) return res.json({ ok: true, links: [] });
  const links = readdirSync(SHARE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readShare(join(SHARE_DIR, f)))
    .filter((d): d is ShareRecord => Boolean(d))
    .map((d) => ({
      slug: d.slug,
      name: d.name,
      savedAt: d.savedAt,
      rev: d.rev ?? 0,
      scan: d.scan,
      variations: Array.isArray((d.setup as { variations?: { name?: string }[] }).variations)
        ? (d.setup as { variations: { name?: string }[] }).variations.map((v) => v.name).filter((n): n is string => typeof n === "string")
        : [],
    }))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  res.json({ ok: true, links });
});

fixtureRouter.get("/links/:slug", (req, res) => {
  const file = sharePath(req.params.slug);
  if (!file || !existsSync(file)) return res.status(404).json({ ok: false, error: "no configuration at this link" });
  const link = readShare(file);
  if (!link) return res.status(404).json({ ok: false, error: "no configuration at this link" });
  res.json({ ok: true, link });
});

fixtureRouter.post("/links", (req, res) => {
  const body = ShareCreate.safeParse(req.body);
  if (!body.success) {
    const issue = body.error.issues[0];
    return res.status(400).json({ ok: false, error: `link not saved: ${issue.path.join(".")} ${issue.message}` });
  }
  const slug = slugify(body.data.name);
  if (!slug) return res.status(400).json({ ok: false, error: "name the configuration with letters or numbers" });
  const file = sharePath(slug);
  if (!file) return res.status(400).json({ ok: false, error: "name the configuration with letters or numbers" });
  if (existsSync(file)) {
    return res.status(409).json({ ok: false, slug, error: "a configuration with this name already exists" });
  }
  mkdirSync(SHARE_DIR, { recursive: true });
  const savedAt = new Date().toISOString();
  const record: ShareRecord = { slug, name: body.data.name, savedAt, rev: 1, scan: body.data.scan, setup: body.data.setup };
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 1));
  renameSync(`${file}.tmp`, file);
  res.json({ ok: true, slug, name: record.name, savedAt, rev: 1, path: `/fixture/${slug}` });
});

fixtureRouter.put("/links/:slug", (req, res) => {
  const file = sharePath(req.params.slug);
  if (!file) return res.status(400).json({ ok: false, error: "no configuration at this link" });
  const body = ShareWrite.safeParse(req.body);
  if (!body.success) {
    const issue = body.error.issues[0];
    return res.status(400).json({ ok: false, error: `link not saved: ${issue.path.join(".")} ${issue.message}` });
  }
  // Same rule as the per-scan save: a write names the revision it started
  // from, and one based on an older revision is refused.
  let rev = 0;
  if (existsSync(file)) {
    rev = readShare(file)?.rev ?? 0;
    if ((body.data.base ?? 0) !== rev) {
      return res.status(409).json({ ok: false, rev, error: "link not saved: it was changed somewhere else after this page opened it — reload to continue from that version" });
    }
  } else {
    return res.status(404).json({ ok: false, error: "no configuration at this link" });
  }
  rev += 1;
  const savedAt = new Date().toISOString();
  const record: ShareRecord = { slug: req.params.slug, name: body.data.name, savedAt, rev, scan: body.data.scan, setup: body.data.setup };
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 1));
  renameSync(`${file}.tmp`, file);
  res.json({ ok: true, slug: record.slug, name: record.name, savedAt, rev, path: `/fixture/${record.slug}` });
});

fixtureRouter.delete("/links/:slug", (req, res) => {
  const file = sharePath(req.params.slug);
  if (!file) return res.status(400).json({ ok: false, error: "no configuration at this link" });
  rmSync(file, { force: true });
  res.json({ ok: true });
});

/* Failures from this router answer in JSON with a sentence the page can show.
   Express's default handler would send an HTML stack trace instead. */
fixtureRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("[fixture]", err);
  const message = err instanceof Error ? err.message : "unexpected error";
  // Upstream model errors carry request detail that means nothing to a user.
  const upstream = /gemini|anthropic|HTTP \d{3}|fetch failed|aborted/i.test(message);
  res.status(upstream ? 502 : 500).json({
    ok: false,
    error: upstream ? "the AI service did not answer — try again in a moment" : message.slice(0, 300),
  });
});
