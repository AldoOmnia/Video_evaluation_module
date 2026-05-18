# APK Bridge

How the Rokid Android app (`comer-rokid-demo/glasses-app`) and any future
device build consume the platform's shared specs and backend.

The contract is intentionally narrow: the APK never depends on TypeScript
source. It depends on two things only:

1. **Generated Kotlin data classes** from the shared YAML specs, dropped in
   `glasses-app/app/src/main/java/com/omnia/comer/spec/`.
2. **HTTP endpoints** the backend already exposes (Section 3 below).

That keeps the device build small and lets the Brain/Eval lab evolve
without forcing APK releases.

---

## 1. Spec consumption — two options

### Option A (recommended): codegen at platform build time

`scripts/generate-kotlin-specs.ts` reads `/shared/**/*.yaml`, validates with
the same Zod schemas the backend uses, and emits Kotlin data classes:

```
glasses-app/app/src/main/java/com/omnia/comer/spec/
  ProcedureSpec.kt   // sealed/data classes mirroring shared/types/procedure.ts
  Taxonomy.kt
  HardwareProfile.kt
  ContextStrategy.kt
  PinionGuideProcedure.kt   // const val INSTANCE = ProcedureSpec(...)
```

Bundled at compile time → zero network/IO at boot, zero schema drift.

Run:

```bash
npm run gen:apk
```

This writes the files into the sibling `comer-rokid-demo` repo at the path
configured by the `APK_PROJECT_ROOT` env var (default
`~/comer-rokid-demo/glasses-app/app/src/main/java/com/omnia/comer/spec`).

### Option B: runtime fetch

For dev / hot-reload of the procedure on real hardware:

```kotlin
val client = SpecClient(BuildConfig.PLATFORM_URL)
val procedure: ProcedureSpec = client.fetchProcedure()  // GET /api/spec/procedure
```

Cache to local files; fall back to last-known-good if offline.

---

## 2. Backend endpoint contracts (stable for the APK)

| Method | Path                  | Used by                          | Notes |
|--------|-----------------------|----------------------------------|-------|
| POST   | `/query`              | Rokid APK voice / vision flow    | Identical shape to legacy `comer-rokid-demo` backend — drop-in compatible. |
| GET    | `/api/spec/procedure` | Optional runtime spec refresh    | Returns full `ProcedureSpec` JSON. |
| GET    | `/api/spec/hardware`  | Provisioning / on-device tuning  | Returns hardware profiles; APK picks `rokid_ai` by default. |
| POST   | `/api/brain/chat`     | Web Brain Explorer (not the APK directly) | Same brain, web only — APK uses `/query` which composes brain + display. |
| POST   | `/api/eval`           | Offline batch evaluation         | The APK can emit telemetry as `SessionEvent[]` and POST here for retro scoring. |

### `/query` request (unchanged from current APK)

```json
{
  "transcript": "what torque for the pinion nut?",
  "image_base64": "<jpeg-bytes-base64, optional>",
  "image_media_type": "image/jpeg"
}
```

### `/query` response (unchanged shape)

```json
{
  "line1": "Torque pinion nut",
  "line2": "210-240 Nm in",
  "line3": "3-pass opposing",
  "line4": "corner sequence.",
  "isAction": false,
  "rawAnswer": "Torque pinion nut to 210–240 Nm in a 3-pass opposing-corner sequence (Comer QE-PG-04). [[advice:09]]"
}
```

The 4-line shape is enforced server-side by
`shared/display-constraints/rokid.ts` so even if the LLM returns long
prose the lens always renders cleanly.

---

## 3. Telemetry → eval (closing the loop)

Once the APK is in the field, it should emit one `SessionEvent` per:

- FSM transition (`stepId`, `label: "correct"`)
- Tier-1 rule firing (`label: "incorrect"`, `errorType`, `priority`)
- Tier-2 LLM verdict (`outcome`, `inputTokens`, `outputTokens`, `latencyMs`)

Schema: `shared/types/events.ts`.

Buffer locally, batch upload to `POST /api/eval` with `liveLLM: false`
(re-score offline). The result is a `RunResult` JSON identical to the
eval-lab simulation — so a single dashboard can show "simulated A4 catch
rate" alongside "actual rokid_ai A4 catch rate on shift 2026-05-17."

---

## 4. Migration steps for `comer-rokid-demo/glasses-app`

1. Point `comer.backend.url` in `local.properties` at this platform's
   backend (default `http://<host>:3001`). The legacy `/query` endpoint is
   the same shape — no code changes required to ship a new APK.
2. (Optional) Add a one-line build step in `glasses-app/build.gradle.kts`
   that runs `npm --prefix ../../Video_evaluation_module run gen:apk`
   before `compileDebugKotlin`. This guarantees the bundled spec is always
   in sync with the YAML.
3. (Optional) Wire the FSM in `shared/fsm/proceduralMemory.ts` to Kotlin
   via the same codegen — or hand-port it (it's ~120 lines of pure logic).

See `comer-rokid-demo/comer-rokid-demo-SPEC.md` for the existing field
layout. The migration is additive — nothing in the existing flow breaks.
