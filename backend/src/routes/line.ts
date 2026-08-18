/**
 * /api/line — live-line status + glasses warnings report for the platform home.
 *
 * Data source strategy (in order):
 *   1. LINE_BRIDGE_URL — the on-site comer-rokid-demo backend exposing the
 *      read-only UNICOMM/SSL04_FARGO façade (`/v1/unicomm/*`). When Comer's
 *      MES connector is published for this platform, set LINE_BRIDGE_URL
 *      (+ LINE_BRIDGE_API_KEY) and these endpoints go live with zero UI work.
 *   2. Stub snapshot — connector-shaped demo data so the home page renders
 *      the exact layout the live wiring will fill in.
 *
 * Payload shapes mirror the UNICOMM connector's `fetchWorkstationSnapshot()`
 * on the connectors/mssql-unicomm-database branch of comer-rokid-demo.
 */
import { Router } from "express";
import { z } from "zod";
import { llmCall } from "../services/anthropic.js";

export const lineRouter = Router();

const BRIDGE_URL = process.env.LINE_BRIDGE_URL?.trim() || null;
const BRIDGE_KEY = process.env.LINE_BRIDGE_API_KEY?.trim() || null;
const BRIDGE_TIMEOUT_MS = 4000;

async function bridgeGet(path: string): Promise<unknown | null> {
  if (!BRIDGE_URL) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
    const res = await fetch(`${BRIDGE_URL.replace(/\/$/, "")}${path}`, {
      signal: ctrl.signal,
      headers: BRIDGE_KEY ? { "x-api-key": BRIDGE_KEY } : {},
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Connector-shaped demo snapshot (SSL04_FARGO field names). */
function stubWorkstationSnapshot() {
  return {
    timestamp: Date.now(),
    station_id: "PG-04",
    station_number: 100,
    test_number: "ST.100",
    session_active: true,
    current_step_code: "S09",
    step_index: 9,
    total_steps: 12,
    current_step_title: "Torque pinion nut — 3-pass sequence",
    current_phase_result: null,
    last_phase_at: new Date(Date.now() - 42_000).toISOString(),
    technician_id: "1042",
    technician_name: "M. Rossi",
    technician_dept: "Assembly",
    serial_number: "CMR-7741-0093",
    model: "P-750 pinion guide",
    measurements: [
      {
        label: "Pinion nut torque — pass 2",
        value: 82.4,
        min: 78,
        max: 86,
        unit: "Nm",
        verdict: "OK",
        in_range: true,
      },
    ],
  };
}

/**
 * Resolve the current line status once, so /status and /ask always agree on
 * what the line looks like (live bridge when configured, demo snapshot else).
 */
async function resolveLineStatus() {
  const [health, workstation] = await Promise.all([
    bridgeGet("/v1/unicomm/health"),
    bridgeGet("/v1/unicomm/workstation"),
  ]);

  if (workstation) {
    return {
      ok: true,
      mode: "live" as const,
      connected: true,
      bridge: BRIDGE_URL,
      mes: (health as Record<string, unknown>)?.config ?? null,
      snapshot: workstation as Record<string, unknown>,
    };
  }

  return {
    ok: true,
    mode: "stub" as const,
    connected: false,
    bridge: BRIDGE_URL,
    detail: BRIDGE_URL
      ? "line bridge unreachable — showing demo snapshot"
      : "LINE_BRIDGE_URL not configured — showing demo snapshot",
    mes: {
      host: "WARKFSQL002",
      database: "SSL04_FARGO",
      station_number: 100,
      readonly: true,
    },
    snapshot: stubWorkstationSnapshot() as Record<string, unknown>,
  };
}

lineRouter.get("/status", async (_req, res) => {
  res.json(await resolveLineStatus());
});

/**
 * Glasses warnings report — per worker/device: warnings fired, mistakes
 * avoided (worker corrected after the warning), captured POV frames, and an
 * avoided-rework saving estimate.
 *
 * Live path (later): aggregate the APK bridge's warning events + captured
 * frames posted back from the glasses. Until then: demo rows using real
 * error taxonomy codes and the repo's POV imagery.
 */
const AVG_REWORK_COST_EUR = 140; // demo estimate: avg rework labor+parts per caught mistake

async function resolveLineReport() {
  const live = await bridgeGet("/v1/line/report"); // future on-site aggregation
  if (live) {
    return { mode: "live", ...(live as Record<string, unknown>) };
  }

  const workers = [
    {
      workerId: "1042",
      workerName: "M. Rossi",
      device: "Rokid glasses · unit 3",
      warningsFired: 14,
      avoided: 11,
      missed: 3,
      topError: "INCOMPLETE · torque sequence cut short",
      frames: [
        { src: "/lab/assets/phase8_frame.jpg", label: "S09 · single-pass torque", code: "INCOMPLETE" },
        { src: "/lab/assets/worker_pov.jpg", label: "S07 · wrong shim SKU", code: "SUBSTITUTION" },
      ],
    },
    {
      workerId: "1087",
      workerName: "L. Bianchi",
      device: "Rokid glasses · unit 1",
      warningsFired: 8,
      avoided: 7,
      missed: 1,
      topError: "SUBSTITUTION · component mismatch",
      frames: [
        // Deployable web-sized crop — the full station panorama
        // (pinion_guide_station.jpg) is gitignored (~7 MB) so it 404s on Render.
        { src: "/lab/assets/report-orientation.jpg", label: "S04 · cup flipped at load", code: "ORIENTATION" },
      ],
    },
    {
      workerId: "1105",
      workerName: "S. Ferrari",
      device: "Rokid glasses · unit 2",
      warningsFired: 5,
      avoided: 5,
      missed: 0,
      topError: "OUT_OF_SPEC · press depth out of range",
      frames: [
        { src: "/lab/assets/phase8_frame.jpg", label: "S11 · press depth check", code: "OUT_OF_SPEC" },
      ],
    },
  ];

  const totalFired = workers.reduce((s, w) => s + w.warningsFired, 0);
  const totalAvoided = workers.reduce((s, w) => s + w.avoided, 0);

  return {
    mode: "stub",
    detail: "demo report — live glasses warning feed not yet published to this platform",
    period: "last 7 days",
    generatedAt: new Date().toISOString(),
    avgReworkCostEur: AVG_REWORK_COST_EUR,
    totals: {
      warningsFired: totalFired,
      avoided: totalAvoided,
      missed: totalFired - totalAvoided,
      estimatedSavingsEur: totalAvoided * AVG_REWORK_COST_EUR,
    },
    workers,
  };
}

lineRouter.get("/report", async (_req, res) => {
  res.json(await resolveLineReport());
});

/* ── Natural-language line questions ─────────────────────────────────────
 *
 * POST /api/line/ask — the plant-director path: a free-text question in
 * English or Italian, answered ONLY from what the MES connector returned.
 *
 * This is the platform side of the curated-tool contract: the connector (or
 * the demo snapshot standing in for it) is the single source of truth, and
 * the model is allowed to phrase it — never to invent a field. Anything the
 * snapshot doesn't carry comes back as an explicit "not in this snapshot"
 * so a director never mistakes a guess for a reading off the line.
 */
const AskSchema = z.object({
  query: z.string().min(1).max(500),
  lang: z.enum(["en", "it"]).optional(),
});

/** Glasses-warning questions need the report, not the workstation snapshot. */
const WARNING_RE =
  /\b(warning|warnings|avvis\w*|error|errors|errore|errori|flag\w*|segnalat\w*|difett\w*|defect|rework|rilavorazion\w*|saving|savings|risparm\w*|avoided|evitat\w*)\b/i;

/** The model occasionally markdown-escapes MES identifiers (SSL04\_FARGO) or
 *  bolds a value even when asked for plain text. Strip that before it reaches
 *  a director's screen. */
function plainify(s: string): string {
  return s
    .replace(/\\([_*`[\]()#+\-.!])/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?]|$)/g, "$1$2")
    .trim();
}

function askSystemPrompt(lang: "en" | "it"): string {
  return [
    "You are the live-line assistant for Comer Industries' Rockford axle line.",
    "You answer questions from plant directors and managers about what the MES",
    "(UNICOMM / SSL04_FARGO, read-only) is reporting right now.",
    "",
    "HARD RULES:",
    "- Answer ONLY from the JSON data given in the user message. It is the",
    "  complete output of the read-only MES connector for this question.",
    "- NEVER invent a value. If the question asks for something the JSON does",
    "  not contain (shift totals, scrap rates, OEE, history, other stations),",
    "  say plainly that the current MES snapshot does not carry it and name",
    "  what it does carry. Do not estimate or extrapolate.",
    "- If mode is 'stub', the numbers are demo values standing in for the",
    "  connector: answer normally but end with one short sentence flagging",
    "  that this is demo data until the line bridge is connected.",
    "- Keep MES vocabulary exact: station ids (ST100, PG-04), step codes (S09),",
    "  serials, part numbers, UNICOMM, SSL04_FARGO, units (Nm, mm).",
    "- Never quote raw JSON field names or nulls (current_step_result: null) —",
    "  you are writing for a plant director, so say what it means instead",
    "  ('the step has not been signed off yet').",
    "- Be concise and decision-ready: 1-3 sentences, no preamble, no bullet",
    "  lists unless you are naming more than three values.",
    "- Reply in plain text, not JSON or markdown.",
    "",
    lang === "it"
      ? "LINGUA: rispondi in ITALIANO, registro tecnico da stabilimento. Lascia invariati: id stazione, codici fase, seriali, part number, MES/UNICOMM/SSL04_FARGO e le unità di misura."
      : "LANGUAGE: reply in English.",
  ].join("\n");
}

lineRouter.post("/ask", async (req, res, next) => {
  try {
    const body = AskSchema.parse(req.body);
    const lang = body.lang ?? "en";
    const wantsWarnings = WARNING_RE.test(body.query);

    const [status, report] = await Promise.all([
      resolveLineStatus(),
      wantsWarnings ? resolveLineReport() : Promise.resolve(null),
    ]);

    // Label each source so the model never presents glasses warnings as MES
    // checks (they are different systems with different meanings).
    const grounding = {
      mode: status.mode,
      mes_connection: status.mes,
      workstation_snapshot_from_mes: status.snapshot,
      ...(report
        ? {
            glasses_warnings_report: {
              note:
                "Warnings fired by the smart glasses (CV/VLM), NOT MES quality checks.",
              period: (report as Record<string, unknown>).period,
              totals: (report as Record<string, unknown>).totals,
              per_worker: (report as Record<string, unknown>).workers,
            },
          }
        : {}),
    };

    const llm = await llmCall({
      system: askSystemPrompt(lang),
      user: [
        `QUESTION: ${body.query}`,
        "",
        "MES CONNECTOR DATA (the only facts you may use):",
        JSON.stringify(grounding, null, 2),
      ].join("\n"),
      // Italian prose runs longer for the same content — give it headroom.
      maxTokens: lang === "it" ? 420 : 280,
    });

    res.json({
      ok: true,
      answer: plainify(llm.text),
      mode: status.mode,
      connected: status.connected,
      mes: status.mes,
      snapshot: status.snapshot,
      detail: "detail" in status ? status.detail : undefined,
      usedReport: Boolean(report),
      stubbed: llm.stubbed,
      latencyMs: llm.latencyMs,
    });
  } catch (e) {
    next(e);
  }
});
