# Brain · Eval Lab — Cursor Handoff

**Project:** Omnia for Comer Industries pilot
**Pilot scope:** Pinion Guide Assembly station (PG-04), Tier-1 automotive
**Current file:** `brain-eval-lab.html` (single-file scaffold, ~2,300 lines)
**Status:** v0.5 — taxonomy-aware, ready for Cursor extraction
**Hardware target:** Rokid AI Glasses (CXR-S SDK, YodaOS-Sprite)

---

## What this is

A unified web application with two modes that share one data model:

1. **Brain Explorer** — visualizes the procedure as a graph, ingests training material (PDFs, CSVs, videos), supports natural-language Q&A against the graph
2. **Evaluate** — scores AI agent behavior on procedural mistake detection across multiple hardware profiles and context strategies, decomposed by error type

The two modes share the same procedure data, hardware profiles, and error taxonomy. Switch via the header toggle.

**What this is NOT yet:**
- A production runtime — that's the Rokid APK
- Connected to real LLMs — chat is stubbed
- Persistent — everything lives in browser memory
- Connected to Comer's OEM database — deferred per scope decision

The scaffold's purpose is to (a) lock down the data model that both the Rokid runtime and the eval pipeline will consume, (b) provide a working evaluation framework that produces real numbers once stubs are replaced, and (c) give Aaron and Comer's quality team something tangible to look at during pilot conversations.

---

## Two modes

### Brain Explorer (default mode)

Three-column layout:

- **Left panel** — ingest controls (PDF, CSV, Video drop zones), seeded sample button, ingested artifact list
- **Center** — Cytoscape graph canvas with the full Pinion Guide procedure rendered as a constellation of nodes
- **Right panel** — either chat input (default) or node detail (when a node is selected)
- **Bottom panel** (collapsible) — video player with manual tagging workflow

**What it does:**
- Visualizes the procedure spec as a graph (ProceduralActivity → KeyStep → Instruction, ExpertAdvice, Tool, Part)
- Lets you click nodes to inspect properties + connected nodes
- Loads PDF/CSV files and creates Document/DataTable nodes attached to the procedure
- Loads video files and opens manual-tag workflow to create VideoSegment nodes with IN/OUT timestamps, KeyStep assignment, and optional error-type tag
- Stubbed chat: ask the brain questions, it retrieves relevant nodes (real, against the actual graph) and generates a canned answer with clickable citations (stubbed, clearly tagged)

### Evaluate

Three-column layout:

- **Left** — session controls (read procedure from Brain, generate simulated session, timeline)
- **Center** — configuration (7 smart glasses profiles, 4 context strategies, run buttons)
- **Right** — results (per-run metrics, cross-run summary, expandable per-error-type breakdown)

**What it does:**
- Generates simulated procedure sessions from the Brain's procedure spec, with anomalies tagged with specific error types drawn from each KeyStep's `errorProfile`
- Runs the simulated session through hardware × strategy combinations, computing catch rate weighted by error priority
- Reports headline metric: **high-priority error catch rate** (not just "catch rate")
- Decomposes per-run results by error group (A-E), by individual error type, by priority bucket
- Supports ablation: run all 4 strategies in sequence for the same hardware

---

## Architecture in 5 layers

The runtime (Rokid APK) architecture this eval lab models:

| Layer | What it does | Where it runs | Frequency |
|---|---|---|---|
| 1. On-device CV | Quantized YOLOv11 detects objects, hands, parts | Rokid (AR1 chip) | Every frame, 5-10 FPS |
| 2. Procedural memory FSM | Tracks current KeyStep, fuses CV + OEM signal | Rokid | On detection change |
| 3. Tier-1 rule check | Deterministic acceptance criteria check | Rokid | Every 2-5s |
| 4. Tier-2 LLM reasoning | Scoped-context Claude call on rule failure | Phone-tethered or cloud | On Tier-1 fail or worker query |
| 5. Display constraint | Truncate/format output for Rokid lens (~90 chars) | Rokid | Per agent response |

The eval lab tests strategies A1-A4, which map to using different subsets of these layers:
- **A1 Baseline** — Skip 2-3, call LLM with current detections only
- **A2 Full Context** — Skip 3, dump everything into LLM prompt
- **A3 Scoped Episodic** — Layers 1, 2, 4 — scoped context per EmBARDiment
- **A4 Tiered Proactive** — All 5 layers, the production target

---

## What's wired (real, working code)

### Brain mode
- ✅ Cytoscape graph initialization with the full Pinion Guide procedure
- ✅ Two layouts: constellation (cose) and procedure flow (breadthfirst)
- ✅ Node selection, detail panel rendering, click-to-navigate between related nodes
- ✅ PDF drop → creates Document node attached to procedure
- ✅ CSV drop → creates DataTable node attached to procedure
- ✅ Video drop → opens video player with manual-tag workflow
- ✅ Sample artifact seeder (7 realistic sample nodes for demo)
- ✅ Artifact list with click-to-graph navigation
- ✅ Chat retrieval: keyword + type-bias scoring against actual graph nodes
- ✅ Citation system: stub-tagged answers, clickable citations select graph nodes
- ✅ Suggested questions in chat empty state

### Video tagging
- ✅ Video player with timeline scrubbing
- ✅ IN/OUT point selection
- ✅ KeyStep assignment dropdown
- ✅ **Error type dropdown filtered by selected KeyStep's `errorProfile`** (high/medium/low priority groupings)
- ✅ Saved tag list with click-to-replay
- ✅ VideoSegment nodes created with error type metadata

### Eval mode
- ✅ Simulated session generation with per-KeyStep error-type-specific anomalies
- ✅ All 7 hardware profiles wired and selectable
- ✅ All 4 context strategies wired and selectable
- ✅ Single-run + ablation (all-4-strategies) execution
- ✅ Hardware-specific effectiveness modifiers (eye-tracking boost, no-camera penalty, no-output penalty)
- ✅ Per-error-type metrics computation
- ✅ Per-error-group (A-E) breakdown
- ✅ Per-priority bucket (high/medium/low) catch rates
- ✅ Headline metric: high-priority catch rate
- ✅ Run detail expansion with group breakdown, error-type breakdown, per-event list

### Shared
- ✅ Mode switcher (Brain ↔ Evaluate)
- ✅ Error taxonomy as a first-class data structure (19 codes × 5 groups)
- ✅ Procedure spec with 12 KeySteps each carrying an `errorProfile`
- ✅ Toast notifications, loading states

---

## What's stubbed (with seams marked in code)

### 1. LLM generation in chat

**Location:** `stubbedLLMCall(query, retrievedNodes)` in the brain chat flow.

**Currently does:** Returns a canned response based on the top-matched node's type. Adds 280-600ms artificial latency. Every response is tagged with a `STUB` label in the UI.

**What's real:** The `retrieveRelevantNodes(query)` function is real — it queries the actual graph state with keyword + type-bias scoring. Only the *generation* step is stubbed. When you swap in real LLM, the retrieval flows in unchanged.

**The seam — replace this with:**
```javascript
async function realLLMCall(query, retrievedNodes) {
  const context = retrievedNodes.map(n => ({
    id: n.id, type: n.type, label: n.label, properties: n.raw
  }));
  const r = await fetch('/api/brain/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-7',  // or claude-sonnet-4-6 for cost
      system: buildBrainSystemPrompt(state.brain),
      messages: [{ role: 'user', content: query }],
      context,
      max_tokens: 400
    })
  });
  const data = await r.json();
  return data.answer;
}
```

The comment block in the source explicitly marks this seam.

### 2. LLM calls in eval scoring

**Location:** `runEvaluation(annotations, hwId, stratId)` in the eval flow.

**Currently does:** Simulates catch / miss / FP outcomes based on each strategy's `catch_rate_ideal` parameter, modulated by hardware capability factors. Generates plausible token counts and latencies. No actual LLM is called.

**Why this is okay:** The simulation is calibrated to EmBARDiment paper findings (A2 > A1 baseline but worse than A3 scoped, A3 close to A4 tiered) so the ranking is directionally correct. The absolute numbers will shift when real LLMs are called.

**The seam:** Replace the `Math.random() < eff` outcome logic with a real Claude API call structured as:
```javascript
// Inside runEvaluation, for each anomaly event:
const promptCtx = assemblePromptForStrategy(stratId, event, procedureSpec);
const response = await fetch('/api/eval', {
  method: 'POST',
  body: JSON.stringify({ model, prompt: promptCtx, hardware: hw })
});
const result = scoreAgainstGroundTruth(response, event);
outcome = result.outcome;
inT = response.usage.input_tokens;
outT = response.usage.output_tokens;
```

### 3. CV pipeline (simulated for eval)

**Currently:** The eval generates anomaly events directly without simulating CV detection. There's no CV layer in the loop.

**Cursor work:** Two paths. Either (a) record real Rokid CV output logs once, replay them in eval, or (b) build a CV-noise injection model that produces realistic detection streams from procedure ground truth. (a) is faster and more honest.

### 4. PDF/CSV content extraction

**Currently:** File becomes a Document/DataTable node with filename and size, but contents aren't parsed.

**Cursor work:** Parse PDF text + extract instructions/specs per page → attach as Instruction nodes. Parse CSV rows → attach as structured data accessible by Tier-1 rules.

### 5. Persistence

**Currently:** Everything in browser memory. Refresh = full reset.

**Cursor work:** See knowledge base recommendation below.

### 6. OEM database integration

**Deferred per scope decision.** Group D error types (intent-vs-reality) are in the taxonomy but the simulated runs don't yet differentiate "with OEM signal" vs "without". This is the next major build after the basics are wired.

### 7. Display constraint simulator

**Currently:** Not implemented. Eval scores LLM outputs as if they were arbitrarily long.

**Cursor work:** Add a function that truncates/scores LLM output against Rokid lens constraints (~90 char glanceable, single sentence preferred, no rich formatting). Score "would this actually be readable on glass" as part of the eval.

---

## Data model

### Procedure spec — the single most important file to extract

**Current location:** Inline JavaScript constant `PINION_GUIDE_PROCEDURE` near the top of the HTML's `<script>` block.

**First Cursor task:** Extract this to a real file (`pinion-guide.yaml` or `.json`) that both the eval lab AND the Rokid APK import. This is the shared-spec pattern.

**Structure:**
```yaml
proceduralActivity:
  id: proc:pinion-guide
  label: Pinion Guide Assembly
  cycleMin: 38
  stationId: PG-04

keysteps:
  - id: step:01
    order: 1
    label: Inspect Pinion Shaft
    risk: low
    acceptance: "No surface defects; runout ≤ 0.015mm"
    errorProfile:
      high_priority: [UNVERIFIED]
      medium_priority: [OMITTED_OBJECT]
      low_priority: [INSERTION]
      not_applicable: [ORIENTATION, SUBSTITUTION, OUT_OF_SPEC]
  # ... 11 more keysteps

instructions:
  - id: instr:01
    label: "Inspect with bright LED, rotate shaft 360°"
    forStep: step:01

expertAdvice:
  - id: advice:01
    label: "Reject shaft if any surface pitting visible..."
    forStep: step:01
    source: "Marco R., 22yr tenure"

tools:
  - id: tool:torque-wrench-250
    label: "Torque Wrench 50-250 Nm"
    sku: CMR-T-3401

parts:
  - id: part:pinion-shaft
    label: "Pinion Shaft"
    sku: CMR-P-4471

stepRequirements:
  step:01:
    tools: [tool:depth-gauge]
    parts: [part:pinion-shaft]
  # ... per step
```

### Error taxonomy — also a shared spec

**Current location:** `ERROR_TAXONOMY` constant + `ERROR_GROUPS` constant in the HTML.

**Structure:**
```yaml
groups:
  A:
    label: "Sequence"
    desc: "When actions happen"
  B:
    label: "Execution"
    desc: "What happens in a step"
  C:
    label: "Specification"
    desc: "Measurements & values"
  D:
    label: "Intent-vs-reality"
    desc: "OEM-fusion exclusive"
  E:
    label: "System"
    desc: "Perception limits"

errors:
  OMISSION:
    group: A
    label: "Omission"
    desc: "Required step not performed"
  # ... 18 more error codes
```

See the **one-page taxonomy PDF** (`omniaclaw-error-taxonomy.pdf`) for the full list with definitions, detection mechanisms, and Pinion-Guide examples.

### Hardware profiles

**Current location:** `HARDWARE_PROFILES` constant. 7 devices: Rokid AI, Snap Spectacles 5G, Project Aria Gen 2, Even Realities G2, Mentra Live, Maverick AI Pro, Raven Glass. Each has `signals` (eye_gaze, camera, display, hand_track, audio_in, audio_out), `dwell_threshold_ms`, `latency_budget_ms`.

### Context strategies

**Current location:** `CONTEXT_STRATEGIES` constant. Four strategies (A1-A4), each with `avg_input_tokens`, `catch_rate_ideal`, `fp_rate`. Values calibrated to EmBARDiment paper directional findings.

---

## Knowledge base — what to use

You mentioned having CSVs, sheets with pictures and steps, and error-rate data. Here's how to integrate them.

### For the procedure spec itself (Phase 1, immediate)

**Recommendation: YAML file in the repo. Single source of truth.**

Why:
- Version controlled (you'll change this constantly during the pilot)
- Reviewable in pull requests (Comer quality engineer can see diffs)
- Loaded identically by the eval lab (web) and the Rokid APK (Android)
- No infrastructure overhead
- Easy to validate with a schema

Path: `/shared/procedure-spec/pinion-guide.yaml`

### For Comer's existing CSV data

**Recommendation: Reference CSVs from the procedure spec by relative path.**

Structure:
```
/shared/
  procedure-spec/
    pinion-guide.yaml
  data/
    tolerances.csv        # press depth, runout limits, etc.
    torque-table.csv      # torque values per fastener type
    shim-sku-lookup.csv   # shim SKU → thickness mapping
    error-rates.csv       # historical frequency per error type per step
  assets/
    step03-orientation.png   # picture reference for "chamfered edge inboard"
    step07-shim-pack.png     # picture reference for shim selection
    # ... one per high-risk step
```

In `pinion-guide.yaml`, reference these by relative path:
```yaml
- id: step:07
  label: Load Shim Pack
  dataReferences:
    - data/shim-sku-lookup.csv
  visualReferences:
    - assets/step07-shim-pack.png
  errorRateData:
    source: data/error-rates.csv
    column: step_07
```

The Brain's chat retrieval can parse and search these. The Rokid APK can ship them as bundled assets. The eval can use the error-rates CSV to weight metric importance.

### For the picture sheets

You mentioned sheets with pictures AND steps indicated. These are likely the most valuable training material asset you have — they encode shop-floor visual knowledge that doesn't exist anywhere else.

**Two ways to handle them:**

1. **Extract as discrete images + metadata.** For each picture, create an asset file in `/assets/` plus a YAML entry that says "this image illustrates step X, shows tool Y in orientation Z." This becomes structured visual knowledge.

2. **OCR + parse as Document nodes.** If the sheets are layout-heavy with annotations on images, run them through document AI (Anthropic's vision API works well here) to extract structure → produce Document nodes with embedded images and structured step references.

I'd suggest (1) for the highest-value reference sheets (one per high-risk step) and (2) for bulk material. Aim for 5-10 high-quality structured visual references, not 200 lossy OCR'd ones.

### For runtime retrieval (Phase 2, when scaling beyond pilot)

When you move past the Comer pilot and need a persistent, queryable backend, **recommendation: Supabase**.

Why Supabase specifically:
- PostgreSQL + pgvector in one service — relational queries AND semantic search
- REST API auto-generated, plays nicely with both web (eval lab) and mobile (Rokid)
- Auth built in (you'll need this for multi-tenancy when Dakkota adds more customers)
- Hosting + ops handled — you're not running a database
- Free tier covers the pilot; paid tier is affordable
- Compatible with the data model: nodes table + edges table, embeddings stored in node rows, JSON columns for flexible metadata

Schema sketch:
```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT,
  data JSONB,
  embedding VECTOR(1024),  -- for semantic search
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  source TEXT REFERENCES nodes(id),
  target TEXT REFERENCES nodes(id),
  type TEXT NOT NULL,
  data JSONB
);
CREATE INDEX nodes_embedding_idx ON nodes USING ivfflat (embedding vector_cosine_ops);
```

For embeddings, use Voyage or OpenAI text-embedding-3-small. The brain's chat retrieval becomes hybrid: keyword (PostgreSQL FTS) + semantic (pgvector cosine) + graph traversal.

**Alternative: Neo4j.** True to Sörqvist's architecture, native Cypher queries for graph traversal, mature tooling. But more ops overhead, no native vector search until recently, more expensive to host. Worth it if graph queries become more central to your value than they currently are.

**For the Cursor build specifically:** don't decide this yet. Build with the JSON/YAML files in the repo, and add Supabase (or Neo4j) when the Rokid APK actually needs persistent queryable retrieval at runtime. That's at least 4-6 weeks out.

---

## Cursor priorities — what to build first

In order of leverage:

### Priority 1: Extract the shared spec (1-2 days)

Pull `PINION_GUIDE_PROCEDURE`, `ERROR_TAXONOMY`, `ERROR_GROUPS`, `HARDWARE_PROFILES`, `CONTEXT_STRATEGIES` out of the HTML into YAML files. Have the eval lab `fetch()` them at load time. Have the Rokid APK consume the same files as bundled assets. Add a schema validator (e.g., `zod` for TypeScript, `pydantic` for Python).

Why first: everything else depends on this. The procedure spec is the data model that drives both the eval and the production runtime. Until it's extracted, you can't actually run the "shared logic" pattern that makes the eval transferable.

### Priority 2: Wire real LLM calls in the Brain chat (1-2 days)

Replace `stubbedLLMCall()` with a real Anthropic API call against the retrieved-node context. Build a small backend (Cloudflare Worker, Vercel function, or similar) that takes the query + retrieved nodes and calls Claude with a procedural-knowledge-aware system prompt. Document the system prompt — it's part of the spec.

Why second: the chat being real (even if naive) is the first thing that makes the Brain feel like a product rather than a demo. It also gives you a feedback loop on what the procedure spec is missing.

### Priority 3: Wire real Anthropic calls in eval scoring (3-5 days)

Replace the simulated `runEvaluation()` outcome logic with real Claude calls structured per the prompt-assembly module. Same backend as priority 2. The eval now produces real numbers instead of calibrated simulations.

This is where you get the first defensible "OmniaClaw catches X% of high-priority errors on Pinion Guide" numbers. Run it on the sample session generator before you have real footage.

### Priority 4: Persistence layer (2-3 days)

Move the in-memory graph state to localStorage minimally, or to Supabase as the real persistence layer. The eval lab should be able to load a previously-saved Brain state.

### Priority 5: Real video annotation pipeline (1-2 weeks)

When you return from the plant with real Comer footage, build:
- Backend service that accepts uploaded videos
- SAM2-based mask propagation for object tracking (alternatively, the YOLOv11 from Sörqvist + label propagation per Budvytis)
- Output as the labeled-session JSON format the eval consumes
- Manual review UI for low-confidence labels

This is where the eval lab transitions from "scores simulated sessions" to "scores real Comer sessions."

### Priority 6: OEM integration (2-3 weeks, deferred)

When MSSQL access is available, build the OEM Bridge service per the architecture discussed earlier. Add the "OEM signal" toggle to the eval lab's Configuration panel. Quantify the value-of-OEM-signal in numbers.

### Priority 7: Display constraint simulator (3-5 days)

Add a Rokid lens specs simulator. Score LLM outputs not just on content correctness but on display feasibility. Adds a meaningful new metric.

---

## Open questions to resolve

Before or during Cursor work, get answers to:

1. **What's actually in `comer-rokid-demo` repo?** Directory tree + main entry point + CV pipeline code + LLM call code. This determines how the shared-spec extraction works in practice.

2. **What's the production model target?** Claude Opus 4.7 (accuracy), Sonnet 4.6 (cost), or Haiku 4.5 (latency)? Affects everything downstream.

3. **Where does the backend live?** Cloudflare Workers, Vercel, AWS Lambda, self-hosted? Affects the API patterns.

4. **What's Comer's actual OEM software?** Plex, Tulip, FactoryLogix, custom? Determines OEM integration approach.

5. **What's the format of Comer's existing picture sheets?** PDF, slide deck, paper printouts that need scanning? Drives the OCR/extraction pipeline.

6. **Who owns the labeled dataset?** Omnia, Comer, jointly? Drives data-handling architecture.

---

## Reference: target file structure for Cursor

```
/comer-rokid-platform/
  /shared/
    /procedure-spec/
      pinion-guide.yaml             # extracted from HTML const
      schema.ts                     # TypeScript types
    /error-taxonomy/
      taxonomy.yaml                 # 19 codes × 5 groups
    /hardware-profiles/
      profiles.yaml                 # 7 devices
    /context-strategies/
      strategies.yaml               # 4 strategies
    /prompt-assembly/
      buildPrompt.ts                # pure function: (state, strategy) → prompt
      systemPrompt.ts               # shared system prompt
    /display-constraints/
      rokid.ts                      # ~90 char limit, etc.
    /fsm/
      proceduralMemory.ts           # the FSM update function
    /rules/
      evaluator.ts                  # Tier-1 rule check
    /data/
      tolerances.csv                # Comer's spec data
      torque-table.csv
      shim-sku-lookup.csv
      error-rates.csv
    /assets/
      step03-orientation.png
      step07-shim-pack.png
      # ... per high-risk step

  /apk/                             # Rokid on-device build
    /src/main/kotlin/com/omnia/...
      MainActivity.kt
      CVPipeline.kt
      AgentLoop.kt                  # imports from /shared/
      RokidDisplay.kt

  /eval-lab/                        # this web app, refactored
    /src/
      brain-explorer.ts
      eval-module.ts                # imports from /shared/
      mock-cv.ts

  /backend/                         # API surface
    /api/
      brain-chat.ts                 # POST /api/brain/chat
      eval-run.ts                   # POST /api/eval

  /annotation-pipeline/             # video processing
    /src/
      sam2-propagator.ts
      whisper-transcriber.ts
      session-exporter.ts           # produces JSON the eval consumes
```

---

## Reference: the seams in code

If you grep the current HTML for "STUB" you'll find every mocked behavior. Specifically:

- `stubbedLLMCall(query, retrieved)` — brain chat generation
- The `runEvaluation()` function's outcome logic — `Math.random() < eff` is where real LLM scoring goes
- Empty `pdfDrop`, `csvDrop` content handlers — files become nodes but contents aren't parsed
- No `realLLMCall()` exists yet — it's documented in code comments as the replacement pattern

The HTML also has a `STUB` visual tag rendered on every stubbed chat response so users can see what's not yet real.

---

## Reference: data the eval produces

Each run produces a JSON object you can export and consume downstream:

```json
{
  "id": "r1736...-3a4f",
  "hardware": { "id": "rokid_ai", "name": "Rokid AI Glasses", "signals": {...} },
  "strategy": { "id": "tiered_proactive", "name": "A4 — Tiered Proactive" },
  "timestamp": "2026-05-13T...",
  "events": [
    { "ts": 421.3, "phase": "Load Shim Pack", "label": "incorrect",
      "errorType": "SUBSTITUTION", "outcome": "caught", "inputTokens": 1402 },
    ...
  ],
  "metrics": {
    "anomalies": 8, "caught": 7, "missed": 1, "false_pos": 0,
    "catch_rate": 0.875,
    "high_priority_catch_rate": 0.95,
    "medium_priority_catch_rate": 0.78,
    "total_input_tokens": 14200,
    "avg_latency_ms": 285,
    "byType": {
      "SUBSTITUTION": { "seen": 3, "caught": 3, "missed": 0 },
      "ORIENTATION":  { "seen": 2, "caught": 2, "missed": 0 },
      ...
    },
    "byGroup": {
      "A": { "seen": 2, "caught": 2 },
      "B": { "seen": 5, "caught": 4 },
      ...
    },
    "byPriority": {
      "high":   { "seen": 6, "caught": 6 },
      "medium": { "seen": 2, "caught": 1 }
    }
  }
}
```

This is the schema downstream consumers should expect: anyone running batch evals, anyone exporting to Comer, anyone training a model on the agent's behavior history.

Each `VideoSegment` node (created via manual tagging) similarly exports:

```json
{
  "id": "vid:session-001-1736...",
  "type": "VideoSegment",
  "label": "Position Guide Bearing · Orientation",
  "fileName": "session-001.mp4",
  "timestampStart": 423.5,
  "timestampEnd": 451.2,
  "errorType": "ORIENTATION",
  "isCorrectExecution": false,
  "attachedTo": "step:03"
}
```

These collectively form the training dataset for the production CV model and the validation dataset for the eval.

---

## Outputs you should have alongside this doc

- `brain-eval-lab.html` — the v0.5 scaffold (single file, runs in browser)
- `omniaclaw-error-taxonomy.pdf` — one-page reference card for the 5-group error taxonomy
- This document — the handoff brief

All three are in `/mnt/user-data/outputs/`.

---

## Last note on philosophy

This scaffold's job isn't to be the production system. It's to lock down three things before they get baked into production code: the data model (procedure spec + error taxonomy + hardware profiles), the architectural pattern (5-layer agent loop), and the eval methodology (per-error-type decomposition with priority weighting).

Once those are stable, the production code in Cursor builds on top with confidence. The eval lab itself can then evolve into a quality-team-facing tool — Comer's QA looks at runs, identifies which error types are under-detected, prioritizes which procedure steps need better rules — while the Rokid APK ships in parallel.

The two-mode architecture (Brain + Eval) is the platform thesis in miniature. The Brain is what Comer ultimately buys (queryable institutional knowledge). The Eval module is how Omnia proves the Brain is well-formed enough to drive a real agent. Same data, two product surfaces. Don't lose sight of that during refactor — keep the shared data layer as the contract between them.
