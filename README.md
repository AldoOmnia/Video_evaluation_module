# Brain · Eval Lab — Platform

The procedural-knowledge graph + agent-evaluation platform behind the
Omnia smart-glasses program.

**Reference material lives in [`docs/`](./docs):**

- [`docs/omnia-error-taxonomy.md`](./docs/omnia-error-taxonomy.md) — the
  Comer Pinion Guide v1 error taxonomy (5 groups × 19 codes) including
  detection mechanism and a Pinion-Guide-specific example per code. This
  is what the agent prompt is grounded in.
- [`docs/papers/`](./docs/papers) — academic papers informing the build:
  - Sener et al., **Assembly101** — mistake-taxonomy foundation (Groups A–B).
  - Jang et al., **EPIC-Tent** — egocentric assembly dataset reference.
  - Flaborea et al., **PREGO** — online mistake detection baseline.
  - **Ti-PREGO** — chain-of-thought + contextual prompt pattern that the
    eval agent's structured output now follows (see
    `docs/papers/ti-prego-contextual-output.png` for the figure that drives
    `agentOutput` shape: completed sequence → current step → next action →
    glasses message).
  - `omnia-error-taxonomy.pdf` — printable one-pager mirror of the markdown.

This repo extracts the data model, prompt assembly, display constraints,
and rule engine from the single-file `brain-eval-lab.html` scaffold into a
shared library. It's designed so the **web eval lab** and a **paired
device APK** consume identical specs over identical endpoint contracts —
independent of which client, which procedure, or which glasses hardware.

> No APK is currently wired to this platform. A separate Rokid test APK
> (kept in a sibling repo) will be paired with this platform's
> `platform-comer` branch for the Comer pilot. The existing
> `comer-rokid-demo` Kotlin app is **not** the test target and is not
> touched by anything in this repo.

> Background: see [`CURSOR-HANDOFF.md`](./CURSOR-HANDOFF.md).

---

## Branch model — one branch per client

`main` is the generic template. Each client lives on its own long-lived
branch with that client's procedure YAML, CSV data, branding, and any
client-specific endpoint additions:

| Branch | Client / pilot | Procedure | Paired APK |
|---|---|---|---|
| `main` | — (generic template) | none | none |
| `platform-comer` | Comer Industries (Tier-1 automotive) | Pinion Guide Assembly (PG-04) | separate Rokid test APK (TBD) |
| `platform-<client>` | future pilots | their procedure YAML | their APK |

Why branches instead of folders or separate repos:
- Each pilot ships at its own cadence and never blocks another.
- The shared platform code stays one diff away (`git merge main`).
- Per-client data, secrets, and tuning never leak across pilots.

When kicking off a new client, branch from `main`, drop in a new YAML
under `shared/procedure-spec/`, and update the `procedure` import in
`backend/src/services/specs.ts` to point at it.

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
- **PDF ingest** parses text via pdf.js (up to 40 pages / 60K chars per file)
- **CSV ingest** parses headers + rows (RFC-4180-ish, up to 500 rows kept in memory)
- **Client artifacts flow to the backend chat** — uploaded files participate in retrieval scoring alongside the canonical procedure graph
- **localStorage persistence** — every ingested artifact survives refresh
- **Live status pills** in both Brain and Evaluate headers reflect backend state (live / stub / offline) via a `/health` ping on boot
- **"Use backend LLM" checkbox** in the Evaluate run bar routes runs through `/api/eval` instead of the in-browser sim
- Kotlin codegen from YAML for the APK (`npm run gen:apk`)
- Cross-spec referential-integrity checker (no dangling error-code or part references)

### Stubbed (clearly marked seams)
- Eval-side LLM scoring is a regex check on whether the response mentions the ground-truth error code — good enough to demonstrate ranking, not a final scorer
- Without `ANTHROPIC_API_KEY` the backend returns deterministic stub answers (clearly tagged in the UI by an amber `LLM: stub` pill)
- OEM database is mocked via fake `oemSignal` in the FSM input — no Plex/Tulip integration

### Deferred (per handoff scope)
- Real video annotation pipeline (placeholder dir only)
- Supabase + pgvector persistence
- Comer OEM integration
- Production model selection (open question in handoff)

---

## How this connects to a paired APK

The backend exposes a stable contract that any glasses APK can consume —
see [`apk-bridge/endpoint-contracts.yaml`](./apk-bridge/endpoint-contracts.yaml)
for the machine-readable spec.

In short:

1. The APK POSTs voice / vision input to `/query` and receives a 4-line
   lens-fitted response (shape: `{ line1, line2, line3, line4, isAction,
   rawAnswer }`). The platform handles retrieval, LLM call, and display
   fitting server-side.
2. Optionally, the APK bundles the procedure on-device via
   `npm run gen:apk` (Kotlin codegen). With `APK_PROJECT_ROOT` set to the
   target APK's source root, the script emits Kotlin data classes that
   mirror the YAML. **No existing APK in this repo or its siblings is the
   default target** — point `APK_PROJECT_ROOT` at the new test APK when
   it's ready.
3. Optionally, the APK posts back telemetry as `SessionEvent[]` to
   `/api/eval` for offline scoring.

Contract details: [`apk-bridge/README.md`](./apk-bridge/README.md).

---

## Priorities (from CURSOR-HANDOFF.md, current status)

| Priority | Status | Notes |
|----------|--------|-------|
| 1. Extract shared spec | DONE | YAML + Zod, single source of truth |
| 2. Real LLM in Brain chat | DONE | `/api/brain/chat`, Anthropic-ready, artifact-aware retrieval |
| 3. Real Anthropic in eval | DONE | `/api/eval?liveLLM=true`; toggle in Evaluate run bar; scorer needs hardening |
| 4. Persistence | DONE (Phase 1) | localStorage for ingested artifacts; Supabase deferred per handoff |
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
