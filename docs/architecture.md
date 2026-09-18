# Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  brain-eval-lab.html  (browser)                                          │
│   Brain Explorer  ──►  fetch('/api/brain/chat')                          │
│   Evaluate        ──►  in-browser sim  |  fetch('/api/eval')             │
│                                                                          │
└──────┬────────────────────────────────────────────────────────┬──────────┘
       │                                                        │
       │  HTTP (same origin when served from /lab/)             │
       │                                                        │
       ▼                                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  backend/   (Express + TypeScript, port 3001)                            │
│                                                                          │
│  routes/                                                                 │
│   /query              ◄── Rokid APK BackendClient.kt (4-line response)  │
│   /api/brain/chat     ◄── Web Brain Explorer                            │
│   /api/eval           ◄── Web Evaluate (real-LLM mode)                  │
│   /api/spec/*         ◄── Anyone needing the canonical YAML             │
│                                                                          │
│  services/                                                               │
│   specs.ts            → loads + validates YAML at boot                  │
│   retrieval.ts        → keyword + type-bias graph search                │
│   anthropic.ts        → Claude SDK; deterministic stub fallback         │
│                                                                          │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       │  imports (TypeScript path alias @shared/*)
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  shared/   (pure TS + YAML — no I/O, no globals)                         │
│                                                                          │
│   procedure-spec/pinion-guide.yaml      ─┐                              │
│   error-taxonomy/taxonomy.yaml          ─┤  validated by Zod            │
│   hardware-profiles/profiles.yaml       ─┤  schemas in types/*.ts       │
│   context-strategies/strategies.yaml    ─┘                              │
│                                                                          │
│   prompt-assembly/                                                       │
│     systemPrompt.ts    → Brain + Agent system prompts                   │
│     buildPrompt.ts     → per-strategy user prompts (A1-A4)              │
│                                                                          │
│   display-constraints/rokid.ts          → fitToDisplay(text, hw)        │
│   fsm/proceduralMemory.ts               → initFsm + stepFsm reducer     │
│   rules/evaluator.ts                    → Tier-1 deterministic check    │
│                                                                          │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       │  codegen (scripts/generate-kotlin-specs.ts)
       │  APK_PROJECT_ROOT=<paired test APK source root>
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  <paired test APK>   (Kotlin/Compose, lives in a separate repo)          │
│                                                                          │
│   spec/PinionGuideProcedure.kt   ← generated (one per client/branch)     │
│   spec/HardwareProfile.kt        ← generated                             │
│   spec/ContextStrategy.kt        ← generated                             │
│   spec/Taxonomy.kt               ← generated                             │
│                                                                          │
│   MainActivity / BackendClient → POST /query  (4-line lens response)    │
│                                                                          │
│   Note: no specific APK is currently the test target. Pair when ready.  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Layer cake — production target (Strategy A4)

| Layer | Code path | Frequency |
|------:|-----------|-----------|
| 1. On-device CV | (TBD, runs in glasses-app, YOLOv11 quantized) | 5-10 Hz |
| 2. Procedural memory FSM | `shared/fsm/proceduralMemory.ts` (codegen → Kotlin) | On detection change |
| 3. Tier-1 rules | `shared/rules/evaluator.ts` (codegen → Kotlin) | 2-5s tick |
| 4. Tier-2 LLM | `backend/src/routes/query.ts` → Anthropic | On Tier-1 fire / voice query |
| 5. Display constraint | `shared/display-constraints/rokid.ts` | Per response |

The eval lab tests A1-A4 by toggling which layers participate. The
production runtime always runs A4 (`tiered_proactive`).

## Model usage & cost metering

Every LLM call is metered at the two service wrappers — `services/anthropic.ts`
and `services/gemini.ts` — rather than at each call site, so a new feature is
metered by construction and cannot silently escape the ledger.

Each call is tagged with a `route` (`UsageRoute` in `services/usage.ts`) naming
the *surface* that made it: `brain-chat`, `assist-vision`, `line-ask`, `eval`,
and so on. Grouping by surface rather than by model is the point of the whole
mechanism: a provider dashboard reports per-model totals, which cannot answer
"which feature costs money?". Vision calls carry ~1MB of reference images and
dominate the bill, and that is invisible per-model.

| Piece | Path |
|------:|------|
| Metering + aggregation + pricing | `backend/src/services/usage.ts` |
| Read API | `GET /api/usage/summary` → `backend/src/routes/usage.ts` |
| UI | Settings → **Usage & cost** (`#usage` section of `settings.html`) |

Notes:

- **Token counts are reported, not estimated.** They come from the provider
  response (`usage` for Anthropic, `usageMetadata` for Gemini). Stub-mode calls
  are the one exception and use a character-per-token approximation, so they are
  counted as non-billable.
- **Cost is an estimate.** Rates live in `rateFor()` keyed by model prefix and
  are overridable with `LLM_RATES_USD_PER_MTOK` without a deploy. The provider
  invoice remains the source of truth, and the UI says so.
- **Recording never breaks a request.** `recordUsage` is best-effort and
  swallows its own failures; a metering bug must not take down a chat answer.
- **The ledger is `.usage/usage.jsonl`** (gitignored), replayed by `loadLedger()`
  on boot so totals survive restarts. On a read-only or ephemeral filesystem the
  totals silently cover only the current process — the UI surfaces that state
  rather than showing a wrong lifetime number.
- The monthly projection averages **billable days only**, so idle days do not
  understate the run-rate.
