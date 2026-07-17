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

lineRouter.get("/status", async (_req, res) => {
  const [health, workstation] = await Promise.all([
    bridgeGet("/v1/unicomm/health"),
    bridgeGet("/v1/unicomm/workstation"),
  ]);

  if (workstation) {
    res.json({
      ok: true,
      mode: "live",
      connected: true,
      bridge: BRIDGE_URL,
      mes: (health as Record<string, unknown>)?.config ?? null,
      snapshot: workstation,
    });
    return;
  }

  res.json({
    ok: true,
    mode: "stub",
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
    snapshot: stubWorkstationSnapshot(),
  });
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

lineRouter.get("/report", async (_req, res) => {
  const live = await bridgeGet("/v1/line/report"); // future on-site aggregation
  if (live) {
    res.json({ mode: "live", ...(live as Record<string, unknown>) });
    return;
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
        { src: "/lab/assets/pinion_guide_station.jpg", label: "S04 · cup flipped at load", code: "ORIENTATION" },
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

  res.json({
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
  });
});
