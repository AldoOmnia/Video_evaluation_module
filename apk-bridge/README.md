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

Machine-readable: [`endpoint-contracts.yaml`](./endpoint-contracts.yaml). Three
further endpoints are drafted but unimplemented — see section 4.

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

## 4. Interventions → the warnings report (draft contract)

The report at `GET /api/line/report` is a hardcoded stub: three fictional
workers, and a savings figure that is an `avoided` count multiplied by a flat
`AVG_REWORK_COST_EUR = 140`. Making it real needs a record of what the glasses
actually told an operator and whether the operator then corrected — which does
not exist anywhere today. Section 3's `SessionEvent` is not it: that is eval
telemetry keyed on a relative offset inside a run, not a plant record on the
wall clock.

Three draft endpoints in
[`endpoint-contracts.yaml`](./endpoint-contracts.yaml) define the shape:

| Method | Path | Carries |
|--------|------|---------|
| POST | `/api/glasses/interventions` | Batch of `InterventionEvent` — metadata only |
| POST | `/api/glasses/frames` | Optional POV still, one per event |
| GET  | `/api/glasses/sync-state` | High-water mark so an end-of-day sync can resume |

Nothing implements them yet. They are written down first so the APK and the
platform can be built against one shape instead of two guesses.

### Four decisions worth keeping

**Idempotency is not optional.** Every event carries a device-generated
`eventId`, and re-sending is a normal outcome rather than an error — a device
that drops connectivity mid-upload will retry, and a savings number that
double-counts on retry is worse than no number. The response separates
`accepted` from `duplicates` so the APK can tell the difference.

**Timestamps are absolute and carry an offset.** The MES stores naive datetimes
and reading them as anything but plant-local cost real debugging time (see
`docs/live-line-qa.md`). This contract does not repeat that. The server also
records its own receipt time so a device with a drifted clock is detectable
rather than silently trusted.

**Imagery is a separate endpoint with a separate lifetime.** POV frames of
identifiable operators carry approval and retention obligations that event
metadata does not — Rockford is in Illinois, and Comer's Italian HQ likely puts
GDPR governance over the controller decision, so this needs a legal read before
any pipeline is built. Splitting them means frames can expire on a short clock
without taking the metrics with them, and `frameIds` is explicitly allowed to
dangle. Approval for the metrics does not have to wait on approval for the
video.

**Resolution carries its evidence.** `resolution` says whether the operator
corrected; `resolutionEvidence` says how we know. That second field is what
separates a defensible savings figure from the current stub — `cv_reobserved`
and `fsm_transition` stand up to a plant manager asking "how do you know", while
`none` means the event should not be counted as avoided at all. `unknown` is an
expected value, not a failure.

### Where the MES comes in

`stationNumber`, `serial` and `phaseId` are the join keys back to
`SSL_ResPhase`. With them, a fired warning can be checked against what the line
actually recorded for that serial and phase — did it end NOK or not. That
correlation is the point of the whole feature: it turns "the glasses caught 11
mistakes" into "11 warnings fired on units that then passed, against a base rate
of N". The query layer for it already exists in
`backend/src/services/mesSql.ts`.

`operatorBadge` is a badge number, never a name. `SSL_Users` is empty in this
deployment, so a name would be unjoinable, and it would introduce a PII field
the platform does not otherwise hold.

### How the existing report surface derives

`eval-lab/public/reports.html` and the home card already render a fixed shape,
so the aggregation has a known target rather than an open question:

| Report field | Derivation |
|--------------|------------|
| `warningsFired` | count where `shownToOperator = true` |
| `avoided` | count where `resolution = corrected` **and** `resolutionEvidence` is `cv_reobserved` or `fsm_transition` |
| `missed` | count where `resolution = not_corrected` |
| `topError` | most frequent `errorCode`, labelled from `shared/error-taxonomy/taxonomy.yaml` |
| `frames` | non-expired `frameIds`, captioned by `stepId` + `errorCode` |
| `workerName` | **drops** — becomes `operatorBadge` |
| `estimatedSavingsEur` | `avoided × AVG_REWORK_COST_EUR`, but only once MES reconciliation supports it; until then report `avoided` without a euro figure rather than a number that cannot be defended |

Events suppressed before the lens (`shownToOperator = false`) are uploaded but
excluded from `warningsFired`. They are how false-positive rate gets measured,
and counting them would inflate every number in the table.

### Storage

The contract names no table, container or provider. The platform is expected to
move to Azure, and that should be a change in where rows land, not a change in
this shape. Two constraints for whenever it is built: glasses events must go to
their own database with their own credentials — the MES connection is read-only
by construction and that property is worth keeping absolute — and the store has
to be durable, which the current `.usage/usage.jsonl`-style local file is not on
an ephemeral host.

## 5. Pairing a new test APK with the platform

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
