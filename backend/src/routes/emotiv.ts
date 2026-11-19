/**
 * Emotiv portal services.
 *
 * This branch does not serve the Comer line, glasses, or reshim feeds.
 * The home page is one service card plus a side rail of the models routed on
 * the Emotiv-Dakkota branch of comer-rokid-demo. The rail is the union of
 * every station-replay trace on disk, so a newer caliper or bolt replay does
 * not hide the harness models, and those replays add their own.
 */
import { Router } from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_LAB_PUBLIC } from "../paths.js";

export const emotivRouter = Router();

const TRACE_DIR = join(EVAL_LAB_PUBLIC, "assets", "emotiv", "traces");

type Routed = { slot: string; id: string; floor?: number };
type Row = { slot: string; id: string; role: string; metric: string; status: string; tone: string };

const ZONE_NAME: Record<string, string> = { EZ4: "radio", EZ5: "gateway" };
const PURPOSE_ROLE: Record<string, (zone: string) => string> = {
  portFill: (z) => `Which ${ZONE_NAME[z] ?? z} openings are fitted`,
  rowLocate: (z) => `Finds the ${ZONE_NAME[z] ?? z} row in the view`,
  seating: (z) => `Whether each ${ZONE_NAME[z] ?? z} connector is pushed home`,
  moduleSeating: (z) => `Seat read on the whole ${ZONE_NAME[z] ?? z} module`,
  identity: () => "Which connector is held up",
};

type LaneModel = {
  slot: string;
  id: string;
  role: string;
  zone?: string;
  floor?: number;
  classes?: number;
  metric?: string;
  status?: string;
};

const SLOT_ORDER = [
  "action",
  "boltStage",
  "caliperParts",
  "boltHeads",
  "boltStandoff",
  "rosebudTags",
  "cvGlasses",
  "cv",
  "fillRadio",
  "fillGateway",
  "seatRadio",
  "seatGatewayBay",
  "seatGateway",
  "rowRadio",
  "vlm",
];

/** Every routed slot the replays on disk reported, not only the newest file. */
export function routedModels(): { rows: Row[]; source: string | null } {
  if (!existsSync(TRACE_DIR)) return { rows: [], source: null };
  const files = readdirSync(TRACE_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) return { rows: [], source: null };
  const byKey = new Map<string, Row & { zones: string[] }>();
  const sources = new Set<string>();
  const add = (row: Row, zone?: string) => {
    const key = `${row.slot}|${row.id}`;
    const zones = zone && zone !== "*" ? [zone] : [];
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { ...row, zones });
      return;
    }
    for (const z of zones) if (!cur.zones.includes(z)) cur.zones.push(z);
  };
  for (const file of files) {
    const trace = JSON.parse(readFileSync(join(TRACE_DIR, file), "utf8"));
    const from = `${trace.source?.branch ?? ""} ${trace.source?.commit ?? ""}`.trim();
    if (from) sources.add(from);
    if (trace.cosmos?.enabled && trace.cosmos.model) {
      add({
        slot: "action",
        id: trace.cosmos.model,
        role: "What the hands are doing",
        metric: (trace.cosmos.classes ?? []).join(" · "),
        status: trace.cosmos.mayWarn || trace.cosmos.mayGate ? "routed" : "ambient line only · may not warn or gate",
        tone: "ok",
      });
    }
    for (const [purpose, zones] of Object.entries((trace.routing ?? {}) as Record<string, Record<string, Routed[]>>)) {
      for (const [zone, chain] of Object.entries(zones)) {
        chain.forEach((m, i) => {
          add({
            slot: m.slot,
            id: m.id,
            role: (PURPOSE_ROLE[purpose] ?? (() => purpose))(zone),
            metric: m.floor != null ? `floor ${m.floor}` : "no floor set",
            status: i === 0 ? "routed" : "fallback",
            tone: "ok",
          }, zone);
        });
      }
    }
    if (trace.models?.vlm?.value) {
      add({
        slot: "vlm",
        id: trace.models.vlm.value,
        role: "What is in view",
        metric: trace.models.vlmFallback?.value ? `then ${trace.models.vlmFallback.value}` : "",
        status: "routed",
        tone: "ok",
      });
    }
    for (const m of (trace.routed ?? []) as LaneModel[]) {
      if (!m?.id || !m.slot) continue;
      const bits = [
        m.classes != null ? `${m.classes} classes` : null,
        m.floor != null ? `floor ${m.floor}` : null,
      ].filter(Boolean);
      add({
        slot: m.slot,
        id: m.id,
        role: m.role || m.slot,
        metric: m.metric || bits.join(" · "),
        status: m.status || "routed",
        tone: "ok",
      }, m.zone);
    }
  }
  const rows = [...byKey.values()]
    .map((row) => ({
      slot: row.slot,
      id: row.id,
      role: row.role,
      metric: row.metric,
      status: row.zones.length ? `${row.status} · ${row.zones.join(", ")}` : row.status,
      tone: row.tone,
    }))
    .sort((a, b) => {
      const ia = SLOT_ORDER.indexOf(a.slot);
      const ib = SLOT_ORDER.indexOf(b.slot);
      return (ia < 0 ? SLOT_ORDER.length : ia) - (ib < 0 ? SLOT_ORDER.length : ib) || a.id.localeCompare(b.id);
    });
  return { rows, source: [...sources].join(" · ") || null };
}

emotivRouter.get("/agent", (_req, res) => {
  res.json({
    ok: true,
    service: "agent",
    configured: false,
    note: "The Emotiv agent is not connected yet. This slot is ready for its model, tools, and session data.",
  });
});

emotivRouter.get("/monitor", (_req, res) => {
  res.json({
    ok: true,
    service: "monitor",
    configured: false,
    note: "No live stream is attached. /monitor plays recorded glasses sessions back through the Emotiv stack.",
  });
});

/* ── Camera checks ────────────────────────────────────────────────────────
 *
 * The page at /live opens this device's camera and posts one frame at a time
 * here. This forwards it to the Emotiv vision backend (comer-rokid-demo,
 * `POST /v1/emotiv/vision/read/:service`) and returns its answer unchanged:
 * a verdict, the words for it, and the boxes to draw.
 *
 * The read is not done in the browser and not done here. The bolt verdict is
 * the detector's class together with the colour on the shank, and the radio
 * read is three passes with a fixed crop geometry. Both live in that backend
 * and are the same code the glasses use, so there is one copy.
 *
 * That backend's key stays on this server. The browser only ever calls this
 * route, behind the portal's own sign-in.
 */
const VISION_URL = (process.env.EMOTIV_VISION_URL ?? "").trim().replace(/\/+$/, "");
const VISION_KEY = (process.env.EMOTIV_VISION_API_KEY ?? "").trim();
/** The radio read is three passes and nine crops, and a cold model is slow. */
const VISION_TIMEOUT_MS = 25_000;

const LIVE_SERVICES: Record<string, { title: string; preview?: boolean }> = {
  "radio-seat": { title: "Radio connectors", preview: true },
  "bolt-02": { title: "Bolt case 02" },
  "bolt-03": { title: "Bolt case 03" },
};

function visionConfigured(): boolean {
  return Boolean(VISION_URL && VISION_KEY);
}

/** The three services, and whether the vision backend says each can answer. */
emotivRouter.get("/live/services", async (_req, res) => {
  const services = Object.entries(LIVE_SERVICES).map(([id, s]) => ({ id, ...s, enabled: null as boolean | null }));
  if (!visionConfigured()) {
    res.json({ ok: true, configured: false, reachable: false, services });
    return;
  }
  try {
    const up = await fetch(`${VISION_URL}/v1/emotiv/vision/read`, {
      headers: { "X-Api-Key": VISION_KEY },
      signal: AbortSignal.timeout(6_000),
    });
    if (!up.ok) throw new Error(`HTTP ${up.status}`);
    const body = (await up.json()) as { services?: Array<{ id: string; enabled?: boolean }> };
    const enabled = new Map((body.services ?? []).map((s) => [s.id, Boolean(s.enabled)]));
    res.json({
      ok: true,
      configured: true,
      reachable: true,
      services: services.map((s) => ({ ...s, enabled: enabled.get(s.id) ?? false })),
    });
  } catch {
    res.json({ ok: true, configured: true, reachable: false, services });
  }
});

emotivRouter.post("/live/:service", async (req, res) => {
  const service = String(req.params.service ?? "");
  if (!LIVE_SERVICES[service]) {
    res.status(404).json({ ok: false, reason: "unknown_service", service });
    return;
  }
  const frame = (req.body as { frame?: unknown } | undefined)?.frame;
  if (typeof frame !== "string" || !frame) {
    res.status(400).json({ ok: false, reason: "no_frame", service });
    return;
  }
  // Answered 200 so the page reads the reason rather than a status code.
  if (!visionConfigured()) {
    res.json({ ok: false, reason: "not_configured", service });
    return;
  }
  try {
    const up = await fetch(`${VISION_URL}/v1/emotiv/vision/read/${service}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": VISION_KEY },
      body: JSON.stringify({ frame }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    if (!up.ok) {
      res.json({ ok: false, reason: `vision_http_${up.status}`, service });
      return;
    }
    res.json(await up.json());
  } catch {
    res.json({ ok: false, reason: "vision_unreachable", service });
  }
});

emotivRouter.get("/models", (_req, res) => {
  const { rows, source } = routedModels();
  res.json({
    ok: true,
    live: false,
    profile: "emotiv",
    station: "Dakkota",
    source: source ? `comer-rokid-demo · ${source}` : null,
    note: source
      ? `Routed model slots across the station replays on disk (${source}). Not a live pull.`
      : "No station replay on disk yet, so there are no routed slots to show.",
    models: rows,
  });
});
