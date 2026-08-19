# Live-line Q&A — natural prompts against UNICOMM (EN / IT)

How a plant director asks the MES a question in plain English or Italian, what
the platform does with it, and how to switch it from demo data to the real line.

## The path a question takes

```
home chat  ──┐
             ├─→ routeOf(q) ─→ POST /api/line/ask ─→ resolveLineStatus()
Comer AI dock┘                                          │
                                                        ├─ MES_MSSQL_* set   → direct read-only SQL   ← preferred
                                                        ├─ LINE_BRIDGE_URL   → read-only UNICOMM façade
                                                        └─ neither           → demo snapshot
                                                        ↓
                                     database configured?  ─── yes ──→ askMes(): plan SQL → execute → phrase
                                                            └── no ───→ Claude on the snapshot JSON alone
                                                        ↓
                                            prose answer (EN or IT) + status card
```

### Direct SQL is the preferred path

The platform connects to `SSL04_FARGO` itself. Six environment variables, no
connector process, no second repository, no bridge — see
[Connecting the database](#connecting-the-database). `npm run mes:check`
verifies it without the server, the UI or an API key.

The bridge remains as a fallback for deployments that only have HTTP reach into
the plant, and the demo snapshot remains for working off-site.

### What "natural prompts against the database" actually means

With a database configured, questions are answered in two passes:

1. **Plan** — the model receives the real schema, read out of
   `INFORMATION_SCHEMA` rather than described in prose, and writes one `SELECT`
   (or declines, if the question is not a database question).
2. **Answer** — a second call sees only the rows that query returned, and writes
   prose.

Splitting them is what keeps it honest. A single pass invites a model to describe
rows it hopes exist; here every number in the answer came out of the database on
that request, and an empty result set has to be reported as one. A failing query
gets exactly one repair pass — SQL Server's errors are specific enough to act on
("cannot group a text column"), and beyond one retry a model tends to thrash.

This is what lifted the ceiling on what can be asked. The snapshot could only
ever describe one station at one instant; the database answers shift counts,
per-station throughput, torque history and plant-wide activity.

### Read-only by construction

The model composes SQL against a live production MES, so "the login is
read-only" cannot be the only defence — Comer's credential is a sysadmin account
today. `assertReadOnly()` is a deny-by-default gate on every statement:

- single statement only (a trailing semicolon is the most that is tolerated)
- must begin `SELECT` or `WITH`
- no DDL, DML, `EXEC`, `sp_`/`xp_`, `OPENROWSET`, `BULK`, `WAITFOR`, `SET`, `USE`
- no `SELECT … INTO` — it creates a table, so "it starts with SELECT" is not a
  sufficient check
- comments and string literals are stripped before scanning, so keywords cannot
  hide inside them
- row cap (`MES_MAX_ROWS`, 200) and query timeout (`MES_QUERY_TIMEOUT_MS`, 15 s)

`npm run test:sql-guard` covers 30 cases, including every bypass above. Sessions
run `READ UNCOMMITTED`: this is a reporting overlay on a production database, and
blocking the plant's own inserts to populate a dashboard would be a bad trade.

### Time is pre-bound, never left to the model

`SSL_ResPhase.Phase_Date` is a SQL `datetime` — no offset — and the plant writes
it in Rockford wall-clock time, while the database host's clock is Italian. So
`GETDATE()` is wrong for filtering it by a margin of hours, and a plain
`new Date()` bound from Node is wrong by the UTC offset. The planner is forbidden
from touching the server clock and given correct parameters instead:
`@plantNow`, `@plantToday`, `@plant24hAgo`, `@plant7dAgo`, `@station`,
`@testNumber`.

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
| "How many units did we build today vs yesterday?" | MES |
| "Which station had the most failures in the last 7 days?" | MES |
| "Most common mistakes on the line" / "Errori più comuni sul pinion guide" | knowledge base |
| "How should the big bearing cup be oriented?" / "Come si orienta la big cup?" | knowledge base |

The test used to be *"is this about right now?"*, which was correct while the
MES path could only read a live snapshot. Now that it queries the whole
database, that test sent every historical question — shift counts, per-serial
history, week-over-week failures — to the knowledge corpus, which answered that
it held no production volumes and advised querying the MES. The MES this
platform is connected to.

So the test is now *"is this a fact the database records, or tribal knowledge
about how to do the job?"* A question routes to the MES when it carries an
unambiguous MES phrasing (serial, session, workstation, "who is working", "a
che fase"), or pairs a MES object — station, operator, phase, measurement,
scrap, unit — with either a counting word or a time window. Procedural phrasing
("how do I…", "why does…", shim/bearing/torque talk) holds it on the corpus,
*unless* an explicit time window is present: "why did ST150 fail this week"
wants the record, not the tribal answer.

The backend has a second router, `WARNING_RE` in `backend/src/routes/line.ts`,
which peels off glasses-report questions before the MES sees them. It is
phrase-based for the same reason: it used to match a bare "error" or "defect"
and so diverted real quality questions to the glasses demo stub.

The rules live in one place, `eval-lab/public/assets/platform.js`:

- `Platform.line.routeOf()` — the home chat's three-way split
- `Platform.line.isLineQuestion()` — the dock's line/knowledge split

They used to be duplicated in `home.html` and `brain-dock.js` and had drifted,
so the same question could reach different destinations from the two surfaces.
Both now share `isLineQuestion()`, and the test asserts they agree.

When adding vocabulary, add a case to `tools/test-routing.mjs` and run it:

```bash
node tools/test-routing.mjs
```

It asserts both that each question routes where it should in English **and**
Italian, and that the two surfaces never disagree.

## Language

The UI language (`omnia.lang`, toggled by the EN/ITA control) is sent as
`lang` on every request and drives a directive in the system prompt. Italian
answers keep MES vocabulary untranslated: station ids, step codes, serials,
part numbers, UNICOMM/SSL04_FARGO, and units.

Card labels come from `eval-lab/public/assets/i18n.js` (`home.lf*`,
`home.kSession`, `home.kUnit`, …); the dock's own labels are in the `IT_DOCK`
table in `brain-dock.js`.

## Connecting the database

Six values in `backend/.env`, then restart:

```
MES_MSSQL_HOST=WARKFSQL002
MES_MSSQL_PORT=1433
MES_MSSQL_DATABASE=SSL04_FARGO
MES_MSSQL_USER=<readonly-login>
MES_MSSQL_PASSWORD=<password>
MES_STATION_NUMBER=100
```

Optional, with defaults that are fine: `MES_PLANT_TZ` (`America/Chicago`),
`MES_MAX_ROWS` (200), `MES_QUERY_TIMEOUT_MS` (15000), `MES_SESSION_IDLE_MS`
(900000 — how long after its last phase a station still counts as working),
`MES_TEST_NUMBER`.

Ask Comer IT for a **read-only** login. The guard enforces read-only regardless,
but least privilege is the correct posture on a production MES.

### Verifying

```bash
npm run mes:check          # no server, no LLM, no API key — just the database
```

It prints the connection, plant-local time, every station active in the last 15
minutes, and the default station's live phase. Run it first on site, and first
whenever the line card shows demo data: it separates "can this machine read the
MES?" from every other thing that could be wrong.

With the server up:

```bash
curl -s localhost:3001/api/mes/health | jq     # 503 if configured but unreachable
curl -s localhost:3001/api/mes/schema  | jq '.tables[].name'
curl -s -X POST localhost:3001/api/mes/ask -H 'Content-Type: application/json' \
  -d '{"query":"How many units did station 110 build today?","lang":"en"}' | jq
```

The server also prints its verdict at boot — `[mes] connected …` or
`[mes] NOT connected … — <reason>` — because a silent downgrade to demo data is
the most confusing failure this platform has.

### Reachability

**Being on the Comer network is not by itself enough** — it matters *which*
machine is on it. The platform process is what opens the SQL connection, so it is
that process's network position that decides everything:

| Platform runs on | Live line works? |
| --- | --- |
| Laptop on the plant network (or Cisco VPN) | Yes — direct SQL to `WARKFSQL002` |
| Hosted (`comer.theomnia.ai` on Render) | No, unless the database is routable from outside: published host, tunnel, or Render dedicated outbound IPs allowlisted by Comer IT |

Putting *your* laptop on the Comer network does not change what the hosted server
can reach. To demo without opening a route, run the platform locally on a machine
that is on the plant network.

## The bridge fallback (optional)

Only needed when the platform has HTTP reach into the plant but not SQL reach.
Set two variables and restart; direct SQL takes precedence when both are set:

```
LINE_BRIDGE_URL=http://<bridge-host>:<port>
LINE_BRIDGE_API_KEY=<key>          # optional; sent as x-api-key
```

`npm run dev:live` starts the glasses connector and the platform together for
this path. It is no longer required for live line data — direct SQL needs neither
the connector nor the `comer-rokid-demo` repository.

`LINE_BRIDGE_URL` points at the on-site backend that fronts the read-only
UNICOMM connector (`connectors/mssql-unicomm-database` on comer-rokid-demo).
The platform reads two routes:

- `GET /v1/unicomm/health` → `{ ok, config: { host, database, station_number, readonly } }`
- `GET /v1/unicomm/workstation` → the workstation snapshot

Timeouts are 12 s for the first read of the process and 4 s afterwards. The
cold budget exists because opening the connector's MSSQL pool routinely takes
longer than a warm query, and timing that out would drop the demo to demo data
while the line is in fact fine.

If either route fails the platform falls back to the demo snapshot rather than
erroring in front of an audience — but it does **not** hide the difference:

| Situation | `mode` | `degraded` | UI |
| --- | --- | --- | --- |
| Bridge answering | `live` | — | "MES connected ✓" |
| `LINE_BRIDGE_URL` not set | `stub` | `none` | "demo data · bridge pending" |
| Bridge set but this read failed | `stub` | `reconnecting` | "line connection dropped · retrying" |

That last row matters mid-demo: a dropped connection used to look identical to
a bridge that was never deployed. The fault reason (`unreachable`, `timeout`,
`http`, `malformed`) is on the response and logged server-side as
`[line] bridge <path> → <fault>`.

### Load on the plant database

`/api/line/status` is cached for 3 s and concurrent callers share one in-flight
read. The home card polls every 30 s **per open tab** and each poll is two
bridge calls, so without this a room full of open tabs multiplies onto a
production MSSQL box for no benefit — nothing on the line changes meaningfully
inside three seconds. `cachedForMs` on the response tells you the age of the
underlying read.

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

## What the database does and does not hold

Verified against the live plant database. All three of these are stated plainly
by the assistant rather than guessed around, which is the difference between a
useful answer and a confident wrong one.

- **`SSL_Users` is empty — 0 rows.** Comer does not populate it, so operator
  *names* do not exist anywhere in this schema. Operator identity is the badge
  number in `SSL_ResPhase.Operator_ID` (e.g. `2406`; `0000` appears when no badge
  was logged in). The table is excluded from joins for this reason — joining it
  only spends a round trip to produce `NULL` and invites the assistant to
  apologise for a missing name as though something were broken.
- **No OEE or cost data.** There is no planned production time, no downtime log
  and no cost-per-part anywhere in the schema, so OEE and scrap cost cannot be
  derived from this MES. Those live in the downtime system and ERP.
- **`Production_Manager` is empty — 0 rows.** It would carry `Model`, so it is
  the obvious place to look for a unit's product, and there is nothing in it. No
  model or product name exists for a serial anywhere in this schema. Excluded
  from joins for the same reason as `SSL_Users`.
- **Most descriptive columns are the legacy `text` type** — `Station_Name`,
  `Phase_Description` — which SQL Server refuses to `GROUP BY`, `ORDER BY` or
  compare. They are marked as such in the schema handed to the planner, and must
  be `CAST(… AS nvarchar(200))` first.

## Counting output — station numbers are not the build order

The MES has no build, order or unit table. A "unit" is a distinct serial in
`SSL_ResPhase`, which means the number you get depends entirely on *where* you
count — and the station numbers do not tell you where the line ends. ST710 is
the highest number on the line but it is a **Stage 4 subassembly**; counting
serials there counts pins, not axles. Four ranges are feeders that never see a
finished unit: ST400-410, ST700-710, ST200-220 and ST500-520.

Asked "how many units did we build today vs yesterday", the planner used to pick
a different definition on each run — 3 vs 8, then 6 vs 7, then 6 vs 45. The last
one is the worst kind of wrong: it counted today at one station and yesterday
line-wide, so the two halves of the comparison were different measures. Ground
truth for that day was 5 vs 5.

The catalog in `backend/src/services/stations.ts` therefore carries `flow`
(`main` or `sub`) and `stageNo` per station, and `topologyForPrompt()` hands the
planner the main flow in stage order, the feeders, the end of line, and three
pinned definitions:

- **units built / produced / completed / output** — distinct serials at the end
  of line, currently Station_Number 190
- **units started** — distinct serials at Station_Number 100
- **serials touched anywhere** — no station filter, and explicitly *not* output

Two rules travel with them. Both sides of a period comparison must come from one
query with an identical station filter, and the count column must be aliased so
the definition survives into the answer (`units_completed_at_190`), which is how
the prose ends up saying "5 units completed at end of line (ST190)" instead of a
bare number that cannot be checked.

## Identifying a product — two traps

Because there is no model column, "was the 425 running?" has to be answered
through the test program. Both of the following produced confidently wrong
answers before being designed out, and both are now spelled out in the planner
prompt.

**Never match a model number against a serial.** Serials (`PCMRS0700653`) are
sequential and carry no product information. Asked when the 425 last ran at
ST100, the planner first wrote `SN LIKE '%425%'`, matched serial `PCMRS0700425` —
the 425th unit built, unrelated to the 425 axle — and reported "41 days ago". The
true answer was four days.

**A shared phase name proves nothing.** The chain from product to recorded work is

```
SSL_Test.Description ('Small Wheel - 425')
  → SSL_Test.Test_Number ('X900.SWR.901.A01')
    → SSL_Phase.Phase_ID   (phases that program publishes)
      → SSL_ResPhase.Phase_ID (what the line actually wrote)
```

but many phase names are generic and published by several programs —
`P100 FEELER GAUGE`, `P100 FEELER GAUGE SNAP RING`. Finding one of those does not
show the target model was running. The query must restrict to phases published by
the target program **and by no other**:

```sql
AND sp.Phase_ID NOT IN (SELECT Phase_ID FROM dbo.SSL_Phase
                        WHERE Station_Number = 100
                          AND Test_Number NOT IN (<target programs>))
```

At ST100 that yields 13 exclusive phases, 12 of them carrying the `4900.12001`
prefix that belongs only to the two 425 programs. That prefix is the decisive
fingerprint.

`npx tsx tools/mes-425-check.mjs` answers the question deterministically, with no
model in the path, so a natural-language answer can always be checked against
raw SQL.

## Step numbering vs. axle variant

ST100 builds the same physical pinion procedure under several test programs, one
per axle variant. Observed on the live line: the tracked program
(`MES_TEST_NUMBER=X900.SWR.901.A01`) publishes its phases as `4900.12001 …`,
while the units running one morning were `4900.12000 …` and the previous
afternoon's were `4900.11003 …` — identical operation names in identical order,
differing only in the variant number.

The connector treats any unpublished `Phase_ID` as an idle session, which is
right for the glasses (never arm a decoy against a mis-identified step) and wrong
for answering "what is happening right now": a station stamping a phase every two
minutes reported as idle all morning.

So the platform splits the two questions:

- `session_active` comes from **recency** — a phase written inside
  `MES_SESSION_IDLE_MS`.
- `step_index` / `total_steps` are claimed **only** when the phase maps to the
  tracked program, because a step number that cannot be verified is worse than
  none. `program_mapped: false` carries a note explaining why.
- The phase name, serial, operator badge and timestamp are **always** reported:
  they come straight from the row and need no mapping to be true.

## Known limits

- "Is the torque in spec?" / "La coppia è in tolleranza?" routes to the
  knowledge base, which answers with the *specification*. Ask "what was the
  last torque reading on the line?" to get the live measurement instead.
- Glasses warnings are a separate system from MES quality checks. When a
  question mentions warnings or errors the report is added to the grounding
  context, labelled so the two are never presented as the same thing.
