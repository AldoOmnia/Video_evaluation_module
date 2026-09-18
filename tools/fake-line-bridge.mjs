/**
 * Stand-in for the on-site UNICOMM line bridge — the read-only MES façade the
 * platform reads when LINE_BRIDGE_URL is set.
 *
 * Used to rehearse the go-live switch without the plant VPN: it answers the
 * same `/v1/unicomm/*` routes as the connector on the
 * connectors/mssql-unicomm-database branch of comer-rokid-demo, so
 * /api/line/status and /api/line/ask take their live code path.
 *
 *   node tools/fake-line-bridge.mjs 4599          # a unit in progress
 *   node tools/fake-line-bridge.mjs 4599 idle     # line quiet, nulls
 *   LINE_BRIDGE_URL=http://localhost:4599 npm run dev
 *
 * Values differ from the built-in demo snapshot on purpose: if an answer
 * quotes them, the request really went through the bridge.
 *
 * The `idle` mode reproduces the connector's own idleWorkstationSnapshot() —
 * session_active:false with null worker/serial/step — which is what a real
 * poll returns whenever nobody is mid-cycle at the station. Worth rehearsing:
 * it is a likely state to hit during a demo.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] || 4599);
const idle = process.argv[3] === "idle";

const health = {
  ok: true,
  config: {
    host: "WARKFSQL002",
    database: "SSL04_FARGO",
    station_number: 100,
    readonly: true,
  },
};

/** Mirrors the connector's idleWorkstationSnapshot(): station_id is the bare
 *  station number and every worker/step/unit field is null. */
const idleWorkstation = () => ({
  timestamp: Date.now(),
  station_id: "100",
  test_number: "ST.100",
  session_active: false,
  step_index: null,
  total_steps: null,
  current_step_code: null,
  current_step_label: null,
  current_phase_number: null,
  current_step_title: null,
  current_phase_result: null,
  last_phase_at: new Date(Date.now() - 41 * 60_000).toISOString(),
  technician_id: null,
  technician_name: null,
  technician_dept: null,
  serial_number: null,
  model: null,
  op: null,
  sequence: null,
  measurements: [],
});

const busyWorkstation = () => ({
  timestamp: Date.now(),
  station_id: "PG-04",
  station_number: 100,
  test_number: "ST.100",
  technician_id: "2288",
  technician_name: "G. Verdi",
  technician_role: "Assembly",
  session_active: true,
  serial_number: "CMR-7741-0417",
  model: "P-750 pinion guide",
  step_index: 4,
  total_steps: 12,
  current_step_code: "S04",
  current_step_title: "Press inboard bearing cup",
  current_step_result: null,
  measurements: [
    {
      label: "Press depth — inboard cup",
      value: 0.004,
      unit: "mm",
      min: 0,
      max: 0.005,
      in_range: true,
    },
  ],
});

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const send = (body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  console.log(`${req.method} ${url.pathname}`);
  if (url.pathname === "/v1/unicomm/health") return send(health);
  if (url.pathname === "/v1/unicomm/workstation") {
    return send(idle ? idleWorkstation() : busyWorkstation());
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}).listen(port, () => {
  console.log(`fake UNICOMM bridge on http://localhost:${port} — ${idle ? "IDLE line" : "unit in progress"}`);
  console.log("point the platform at it:");
  console.log(`  LINE_BRIDGE_URL=http://localhost:${port} npm run dev`);
});
