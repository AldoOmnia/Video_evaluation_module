/**
 * Emotiv portal services.
 *
 * This branch does not serve the Comer line, glasses, or reshim feeds.
 * The home page is one service card plus a side rail of the models routed on
 * the Emotiv-Dakkota branch of comer-rokid-demo. The rail is read from the
 * newest station-replay trace on disk, which holds what that stack's own
 * health endpoint reported when the recording was played through it.
 */
import { Router } from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** The routed slots as the stack reported them on the newest replay. */
function routedModels(): { rows: Row[]; source: string | null } {
  if (!existsSync(TRACE_DIR)) return { rows: [], source: null };
  const newest = readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, at: statSync(join(TRACE_DIR, f)).mtimeMs }))
    .sort((x, y) => y.at - x.at)[0];
  if (!newest) return { rows: [], source: null };
  const trace = JSON.parse(readFileSync(join(TRACE_DIR, newest.f), "utf8"));
  const rows: Row[] = [];
  if (trace.cosmos?.enabled && trace.cosmos.model) {
    rows.push({
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
        rows.push({
          slot: m.slot,
          id: m.id,
          role: (PURPOSE_ROLE[purpose] ?? (() => purpose))(zone),
          metric: m.floor != null ? `floor ${m.floor}` : "no floor set",
          status: `${i === 0 ? "routed" : "fallback"}${zone === "*" ? "" : ` · ${zone}`}`,
          tone: "ok",
        });
      });
    }
  }
  if (trace.models?.vlm?.value) {
    rows.push({
      slot: "vlm",
      id: trace.models.vlm.value,
      role: "What is in view",
      metric: trace.models.vlmFallback?.value ? `then ${trace.models.vlmFallback.value}` : "",
      status: "routed",
      tone: "ok",
    });
  }
  return { rows, source: `${trace.source?.branch ?? ""} ${trace.source?.commit ?? ""}`.trim() };
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

emotivRouter.get("/models", (_req, res) => {
  const { rows, source } = routedModels();
  res.json({
    ok: true,
    live: false,
    profile: "emotiv",
    station: "Dakkota",
    source: source ? `comer-rokid-demo · ${source}` : null,
    note: source
      ? `Routed model slots as the stack reported them on the newest station replay (${source}). Not a live pull.`
      : "No station replay on disk yet, so there are no routed slots to show.",
    models: rows,
  });
});
