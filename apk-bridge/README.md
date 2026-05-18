# APK Bridge

Contract surface between this platform and any paired glasses APK.

The contract is intentionally narrow: the APK depends on **two things only**:

1. **Generated Kotlin data classes** from the shared YAML specs, dropped
   into the APK source tree (path is configurable, default
   `com/omnia/glasses/spec/`).
2. **HTTP endpoints** the platform's backend exposes (see Section 3).

That keeps the device build small and lets the Brain/Eval lab evolve
without forcing APK releases.

> No specific APK is currently the test target for this platform. The
> Comer pilot will pair this platform's `platform-comer` branch with a
> dedicated Rokid test APK in a separate repo. The existing
> `comer-rokid-demo` Kotlin app is **not** touched by this platform and
> should not be used as the integration target.

---

## 1. Spec consumption — two options

### Option A (recommended): codegen at platform build time

`scripts/generate-kotlin-specs.ts` reads `/shared/**/*.yaml`, validates
with the same Zod schemas the backend uses, and emits Kotlin data
classes:

```
<APK source root>/<package path>/spec/
  ProcedureSpec.kt        // mirrors shared/types/procedure.ts
  Taxonomy.kt
  HardwareProfile.kt
  ContextStrategy.kt
  PinionGuideProcedure.kt // const-style object with the loaded YAML data
```

Bundled at compile time → zero network/IO at boot, zero schema drift.

Run with the APK's source root passed in:

```bash
APK_PROJECT_ROOT=/abs/path/to/<test-apk>/app/src/main/java/com/omnia/glasses/spec \
  npm run gen:apk
```

If `APK_PROJECT_ROOT` is unset or doesn't exist, the script logs a
warning and exits cleanly — so it's safe to run in CI even when no APK
is paired.

### Option B: runtime fetch

For hot-reload of the procedure on real hardware:

```kotlin
val client = SpecClient(BuildConfig.PLATFORM_URL)
val procedure = client.fetchProcedure()  // GET /api/spec/procedure
```

Cache to local files; fall back to last-known-good if offline.

---

## 2. Backend endpoint contracts (stable for any paired APK)

| Method | Path                  | Purpose | Used by |
|--------|-----------------------|---------|---------|
| POST   | `/query`              | Voice / vision query → 4-line lens response | Test APK |
| GET    | `/api/spec/procedure` | Runtime spec fetch | Test APK (optional) |
| GET    | `/api/spec/hardware`  | Hardware profiles list | Test APK (optional) |
| POST   | `/api/brain/chat`     | Web Brain Explorer chat | Eval Lab UI |
| POST   | `/api/eval`           | Score a batch of `SessionEvent`s | Eval Lab + APK telemetry upload |

Machine-readable: [`endpoint-contracts.yaml`](./endpoint-contracts.yaml).

### `/query` request

```json
{
  "transcript": "what torque for the pinion nut?",
  "image_base64": "<jpeg-bytes-base64, optional>",
  "image_media_type": "image/jpeg"
}
```

### `/query` response — always 4 lines

```json
{
  "line1": "Torque pinion nut",
  "line2": "210-240 Nm in",
  "line3": "3-pass opposing",
  "line4": "corner sequence.",
  "isAction": false,
  "rawAnswer": "Torque pinion nut to 210–240 Nm in a 3-pass opposing-corner sequence."
}
```

The 4-line shape is enforced server-side by
`shared/display-constraints/rokid.ts` (per-line + total char budgets come
from the hardware profile YAML), so the lens always renders cleanly
regardless of what the LLM returns.

---

## 3. Telemetry → eval (closing the loop)

Once the test APK is in the field, it should emit one `SessionEvent` per:

- FSM transition (`stepId`, `label: "correct"`)
- Tier-1 rule firing (`label: "incorrect"`, `errorType`, `priority`)
- Tier-2 LLM verdict (`outcome`, `inputTokens`, `outputTokens`, `latencyMs`)

Schema: [`shared/types/events.ts`](../shared/types/events.ts).

Buffer locally, batch upload to `POST /api/eval` with `liveLLM: false`
(re-score offline). The result is a `RunResult` JSON identical to the
eval-lab simulation — so one dashboard can compare "simulated A4 catch
rate" alongside "actual A4 catch rate on shift 2026-05-17."

---

## 4. Pairing a new test APK with the platform

The platform makes **no assumptions** about the APK's package, build
system, or framework. Any client that can speak HTTP and render four
lines of text can pair.

To bring up a new APK:

1. Spin up the platform: `npm run dev` (defaults to port 3001).
2. Point the APK's backend URL at `http://<host>:3001`.
3. (Optional) Run `npm run gen:apk` with `APK_PROJECT_ROOT` pointed at
   the APK's source tree so the procedure is bundled on-device.
4. (Optional) Wire the FSM in `shared/fsm/proceduralMemory.ts` to Kotlin
   via the same codegen pattern — or hand-port it (it's ~120 lines of
   pure logic).

When pairing with a different client's branch (e.g. `platform-comer`),
check out that branch first — the procedure YAML, CSVs, and any
client-specific endpoints live there.
