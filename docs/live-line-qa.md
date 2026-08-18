# Live-line Q&A — natural prompts against UNICOMM (EN / IT)

How a plant director asks the MES a question in plain English or Italian, what
the platform does with it, and how to switch it from demo data to the real line.

## The path a question takes

```
home chat  ──┐
             ├─→ routeOf(q) ─→ POST /api/line/ask ─→ resolveLineStatus()
Comer AI dock┘                                          │
                                                        ├─ LINE_BRIDGE_URL set → read-only UNICOMM façade
                                                        └─ not set            → connector-shaped demo snapshot
                                                        ↓
                                              Claude, grounded strictly on that JSON
                                                        ↓
                                            prose answer (EN or IT) + status card
```

`/api/line/ask` never queries SQL itself. It reads whatever the connector
returned and lets Claude phrase it. The model is instructed that the JSON is
the only admissible fact source, so a question the snapshot cannot answer
(shift totals, OEE, scrap, other stations) comes back as an explicit "not in
this snapshot" instead of a plausible-sounding guess.

## Routing — which questions reach the MES

Three destinations, and the split matters: tribal-knowledge questions must not
be answered from the MES card, and live-state questions must not be answered
from the knowledge corpus.

| Question | Goes to |
| --- | --- |
| "What is happening on the line right now?" / "Cosa succede in linea adesso?" | MES |
| "Who is working on station 100?" / "Chi sta lavorando alla stazione 100?" | MES |
| "What serial number is on the station?" / "Quale seriale c'è in stazione?" | MES |
| "What step are they on?" / "A che fase sono?" | MES |
| "Is the MES connected?" / "Il MES è connesso?" | MES |
| "Show me the glasses warnings report" / "Mostrami il report degli avvisi" | report card |
| "Most common mistakes on the line" / "Errori più comuni sul pinion guide" | knowledge base |
| "How should the big bearing cup be oriented?" / "Come si orienta la big cup?" | knowledge base |

Live-line routing needs either an MES-specific noun (MES, UNICOMM, serial,
session, workstation) or a present-state phrasing ("who is working", "chi sta
lavorando", "a che fase"), or else a *right now* marker plus a line subject.
Mentioning "the line" alone is not enough — "most common mistakes on the line"
is knowledge, not a reading.

The rules live in two places, deliberately duplicated so neither surface
depends on the other loading:

- `eval-lab/public/home.html` → `routeOf()`
- `eval-lab/public/assets/brain-dock.js` → `isLineQuestion()`

Keep them in sync when adding vocabulary.

## Language

The UI language (`omnia.lang`, toggled by the EN/ITA control) is sent as
`lang` on every request and drives a directive in the system prompt. Italian
answers keep MES vocabulary untranslated: station ids, step codes, serials,
part numbers, UNICOMM/SSL04_FARGO, and units.

Card labels come from `eval-lab/public/assets/i18n.js` (`home.lf*`,
`home.kSession`, `home.kUnit`, …); the dock's own labels are in the `IT_DOCK`
table in `brain-dock.js`.

## Going live

**Being on the Comer network is not by itself enough.** Two different things get
confused here:

- The `user-mssql-readonly` MCP server in Cursor talks to `WARKFSQL002`
  directly. That does start working again as soon as the machine running Cursor
  is on the plant network.
- The platform has **no SQL driver at all** — `backend/` does not depend on
  `mssql`. It only makes HTTP calls to `/v1/unicomm/*`. So it needs the
  connector's HTTP façade running *and* reachable from wherever the platform
  process lives.

That second point decides the demo:

| Platform runs on | Live line works? |
| --- | --- |
| Laptop on the plant network, bridge on `localhost` | Yes |
| Hosted (`comer.theomnia.ai` on Render) | Only if the bridge is reachable from the public internet — Render cannot route to a plant LAN address |

Set two environment variables on the platform service and restart. No UI work:

```
LINE_BRIDGE_URL=http://<bridge-host>:<port>
LINE_BRIDGE_API_KEY=<key>          # optional; sent as x-api-key
```

`LINE_BRIDGE_URL` points at the on-site backend that fronts the read-only
UNICOMM connector (`connectors/mssql-unicomm-database` on comer-rokid-demo).
The platform reads two routes with a 4 s timeout:

- `GET /v1/unicomm/health` → `{ ok, config: { host, database, station_number, readonly } }`
- `GET /v1/unicomm/workstation` → the workstation snapshot

If either is unreachable the platform silently falls back to the demo snapshot
and the UI says so — it never blocks or errors out in front of an audience.

### Contract check against the connector branch

Verified against `connectors/mssql-unicomm-database`, so no adapter is needed:

- Routes match. `backend/routes/unicomm.js` mounts at `/v1/unicomm` and serves
  `/health` (returning `{ ok, config }`) and `/workstation`.
- Auth matches. The connector's `requireApiKey` accepts `X-Api-Key` or
  `Authorization: Bearer`; the platform sends `x-api-key`. **The platform's
  `LINE_BRIDGE_API_KEY` must equal the connector's `BACKEND_API_KEY`** — that
  variable is mandatory, the connector refuses to boot without it.
- Field names match. `station_id`, `station_number`, `session_active`,
  `technician_id`, `technician_name`, `serial_number`, `model`,
  `current_step_code`, `current_step_title`, and `measurements[]` with
  `label` / `value` / `min` / `max` / `in_range` all line up with the status
  card. `step_index` and `total_steps` come from `normalizeStepMeta()`.
- One gap, handled: the connector's measurements carry no `unit` field, so the
  card renders the bare number. Not a break.

Connector environment variables use an `UNCOMM_` prefix (spelled without the
second `I`) — `UNCOMM_MSSQL_HOST`, `UNCOMM_MSSQL_DATABASE`,
`UNCOMM_STATION_NUMBER`, plus `MES_ADAPTER=unicomm` and `UNCOMM_ENABLED=1`.
On the plant WiFi/LAN `WARKFSQL002` resolves directly and no VPN is required;
the Cisco VPN is only for off-site development.

### When the line is quiet

A real poll returns `session_active: false` with null worker/serial/step
whenever nobody is mid-cycle — a likely state to hit mid-demo. Rehearse it with
`node tools/fake-line-bridge.mjs 4599 idle`. Answers should read like "Station
ST100 is currently idle — no active session, no unit loaded, no technician
logged in", quoting `last_phase_at`, with no raw nulls.

## Rehearsing the switch without the VPN

`tools/fake-line-bridge.mjs` answers the same two routes with values that
differ from the built-in demo snapshot, so you can tell which source an answer
came from:

```
node tools/fake-line-bridge.mjs 4599          # a unit in progress
node tools/fake-line-bridge.mjs 4599 idle     # line quiet, nulls
LINE_BRIDGE_URL=http://localhost:4599 npm run dev
```

Live mode is working when:

- `GET /api/line/status` returns `"mode": "live"`
- home service card 02 shows `MES connected ✓` / `MES connesso ✓`
- answers quote the bridge's values (`G. Verdi`, `CMR-7741-0417`, step `S04`)
- the "demo data" caveat sentence is gone from the prose

## Smoke test

```bash
# demo mode — no bridge configured
curl -s localhost:3001/api/line/status | jq '.mode'          # "stub"

# English
curl -s -X POST localhost:3001/api/line/ask \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is happening on the line right now?","lang":"en"}' | jq -r '.answer'

# Italian
curl -s -X POST localhost:3001/api/line/ask \
  -H 'Content-Type: application/json' \
  -d '{"query":"Chi sta lavorando alla stazione 100?","lang":"it"}' | jq -r '.answer'

# must refuse to invent — the snapshot has no shift aggregates
curl -s -X POST localhost:3001/api/line/ask \
  -H 'Content-Type: application/json' \
  -d '{"query":"What was our OEE for the whole shift?","lang":"en"}' | jq -r '.answer'
```

Expect ~3–9 s per answer: one Claude call on top of the bridge read.

## Known limits

- One station per snapshot. The connector exposes the configured
  `STATION_NUMBER` (100 = Pinion Guide), so cross-station and shift-level
  questions are answered with an explicit "not in this feed". Widening that
  means adding curated tools to the connector, not prompt changes here.
- "Is the torque in spec?" / "La coppia è in tolleranza?" routes to the
  knowledge base, which answers with the *specification*. Ask "what was the
  last torque reading on the line?" to get the live measurement instead.
- Glasses warnings are a separate system from MES quality checks. When a
  question mentions warnings or errors the report is added to the grounding
  context, labelled so the two are never presented as the same thing.
