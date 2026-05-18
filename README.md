# Comer · Rokid Platform

**Brain · Eval Lab** — the procedural-knowledge graph + agent-evaluation
platform behind the Aequilibrium / OmniaClaw pilot at Comer Industries
(station PG-04, Pinion Guide Assembly).

This repo extracts the data model, prompt assembly, display constraints,
and rule engine from the single-file `brain-eval-lab.html` scaffold into a
shared library that both the **web eval lab** and the **Rokid Android
APK** (`comer-rokid-demo/glasses-app`) consume.

> Background: see [`CURSOR-HANDOFF.md`](./CURSOR-HANDOFF.md).

---

## Quick start

```bash
# 1. install
npm install
npm --workspace backend install
npm --workspace eval-lab install

# 2. validate the YAML specs against the Zod schemas
npm run validate

# 3. (optional) configure Anthropic key
cp backend/.env.example backend/.env
#   edit ANTHROPIC_API_KEY; leaving it blank runs the platform in STUB mode

# 4. boot the backend (also serves the eval lab UI)
npm run dev

# 5. open
open http://localhost:3001/lab/
```

The lab loads `brain-eval-lab.html` from the repo root. The Brain chat
talks to `/api/brain/chat`; toggling `USE_BACKEND_EVAL` in the dev console
routes the Evaluate runs through `/api/eval`.

---

## Layout

```
shared/                       # the contract
  procedure-spec/             # YAML procedure (Pinion Guide v0.5)
  error-taxonomy/             # 5 groups × 19 codes
  hardware-profiles/          # 7 smart-glasses devices
  context-strategies/         # A1-A4 prompt strategies
  prompt-assembly/            # pure functions: (state, strategy) -> prompt
  display-constraints/        # Rokid lens fitter (4 lines × ~22 chars)
  fsm/                        # procedural memory state machine
  rules/                      # Tier-1 deterministic rule evaluator
  data/                       # Comer CSVs (torque, shim, tolerances, error rates)
  types/                      # Zod schemas + TypeScript types (source of truth)

eval-lab/                     # the web app (refactored client-side)
  src/                        # TS modules: api client, session generator
  public/                     # static assets (loaded by the HTML)

backend/                      # Express server
  src/
    routes/                   # /query (Rokid APK), /api/brain/chat, /api/eval, /api/spec/*
    services/                 # anthropic wrapper, spec loader, retrieval
    server.ts                 # boot — also serves the eval lab HTML at /lab/

apk-bridge/                   # contract surface for the Rokid Android app
  README.md                   # migration guide for comer-rokid-demo
  endpoint-contracts.yaml     # machine-readable endpoint shapes

annotation-pipeline/          # placeholder — fills in once Comer footage is uploaded
scripts/
  validate-specs.ts           # CI-friendly Zod check across all YAML
  generate-kotlin-specs.ts    # codegen: YAML -> Kotlin data classes for the APK

brain-eval-lab.html           # v0.5 single-file demo, patched to use the backend
CURSOR-HANDOFF.md             # design intent / scope / open questions
```

---

## What is and isn't real

Mirrors `CURSOR-HANDOFF.md` §"What's wired" / "What's stubbed", updated:

### Wired & functional
- All shared specs in YAML, validated by Zod at load time
- Pure-TS prompt assembly per strategy A1-A4
- Display-constraint fitter (Rokid 4-line / ~88 char)
- Procedural-memory FSM with OEM/CV/dwell fusion
- Tier-1 rule evaluator (R1 omitted-object, R2 extra-object, R3 OEM mismatch, R4 numeric-band)
- Backend `/api/brain/chat`, `/api/eval`, `/api/spec/*`, and Rokid-compatible `/query`
- Anthropic SDK integration (claude-sonnet-4-6 default; opus / haiku selectable)
- Deterministic stub mode (boots without an API key)
- Kotlin codegen from YAML for the APK (`npm run gen:apk`)
- Cross-spec referential-integrity checker (no dangling error-code or part references)

### Stubbed (clearly marked seams)
- `runEvaluation` defaults to in-browser simulation; `USE_BACKEND_EVAL=true` opts into real `/api/eval`
- Eval-side LLM scoring is a regex check on whether the response mentions the ground-truth error code — good enough to demonstrate ranking, not a final scorer
- PDF/CSV ingest creates Document/DataTable graph nodes but doesn't parse content
- Persistence is in-memory in the browser; backend is stateless
- OEM database is mocked via fake `oemSignal` in the FSM input — no Plex/Tulip integration

### Deferred (per handoff scope)
- Real video annotation pipeline (placeholder dir only)
- Supabase + pgvector persistence
- Comer OEM integration
- Production model selection (open question in handoff)

---

## How this connects to the Rokid APK

The existing [`comer-rokid-demo`](../comer-rokid-demo) glasses-app POSTs
to `/query` with `{ transcript, image_base64? }` and renders the response
as four lines on the lens. This platform's backend ships an exact-shape
`/query` implementation, so the APK can point at this server without code
changes:

```properties
# comer-rokid-demo/glasses-app/local.properties
comer.backend.url=http://<host>:3001
```

To bundle the procedure on-device:

```bash
APK_PROJECT_ROOT=/abs/path/to/glasses-app/app/src/main/java/com/omnia/comer/spec \
  npm run gen:apk
```

Full migration walkthrough: [`apk-bridge/README.md`](./apk-bridge/README.md).

---

## Priorities (from CURSOR-HANDOFF.md, current status)

| Priority | Status | Notes |
|----------|--------|-------|
| 1. Extract shared spec | DONE | YAML + Zod, single source of truth |
| 2. Real LLM in Brain chat | DONE | `/api/brain/chat`, Anthropic-ready |
| 3. Real Anthropic in eval | DONE | `/api/eval?liveLLM=true`; scorer needs hardening |
| 4. Persistence | PENDING | In-memory only; Supabase deferred per handoff |
| 5. Video annotation pipeline | SCAFFOLDED | Empty `/annotation-pipeline` dir |
| 6. OEM integration | DEFERRED | FSM accepts `oemSignal`; no MSSQL bridge yet |
| 7. Display-constraint simulator | DONE | `shared/display-constraints/rokid.ts` + `scoreDisplay` |

---

## Commands

```bash
npm run validate     # Zod-check every YAML + cross-spec referential integrity
npm run dev          # boot backend at :3001, serves /lab/ and /query and /api/*
npm run build        # compile backend + eval-lab TS
npm run gen:apk      # emit Kotlin spec into the sibling comer-rokid-demo repo
npm run typecheck    # strict TS across all packages
```
