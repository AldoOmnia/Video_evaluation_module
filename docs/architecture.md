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
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  comer-rokid-demo/glasses-app/  (Kotlin/Compose, Rokid CXR-S SDK)        │
│                                                                          │
│   com/omnia/comer/spec/PinionGuideProcedure.kt   ← generated            │
│   com/omnia/comer/spec/HardwareProfile.kt        ← generated            │
│   com/omnia/comer/spec/ContextStrategy.kt        ← generated            │
│   com/omnia/comer/spec/Taxonomy.kt               ← generated            │
│                                                                          │
│   MainActivity.kt       → voice (KEYCODE_DPAD_CENTER) + vision           │
│                          (KEYCODE_VOLUME_UP)                             │
│   BackendClient.kt      → POST /query  (4-line lens response)           │
│   VoiceEngine.kt        → STT                                            │
│   CameraCapture.kt      → JPEG → base64                                  │
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
