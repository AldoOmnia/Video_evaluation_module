# Omnia Error Taxonomy — Comer Pinion Guide v1

Error categories for procedural mistake detection in the Comer Industries Tier-1 automotive pilot. Synthesizes Assembly101 (Sener et al. 2022) mistake categories with two architecturally novel groups: **intent-vs-reality** (Group D, enabled by OEM-signal fusion) and **system perception errors** (Group E). Each row maps an error type to its detection mechanism and a concrete Pinion Guide example.

---

## A. Sequence errors — *when* actions happen

| Code | Definition | Detection mechanism | Pinion Guide example |
|---|---|---|---|
| `OMISSION` | Required step not performed | FSM never entered state; next state entry condition met without prior step's completion | Worker skips S02 Lubricate, goes from S01 directly to S03 Position |
| `INSERTION` | Extra action outside the procedure | Detection signature matches no expected state; or, re-execution of completed step | Worker re-torques pinion nut after rotational torque check (S10) is already complete |
| `ORDER` | Right steps, wrong sequence | FSM transition violates `required_priors` constraint | S07 Shim Pack loaded before S06 Crush Sleeve installed |
| `INCOMPLETE` | Step entered but not fully done | State `exit_condition` not satisfied at transition time | Worker abandons torque sequence after 2 of 3 required passes |

## B. Execution errors — *what happens within* a step

| Code | Definition | Detection mechanism | Pinion Guide example |
|---|---|---|---|
| `SUBSTITUTION` | Right step, wrong object | CV detects object SKU/class not matching expected for current state | Wrong shim thickness loaded — 0.024 mm instead of spec 0.028 mm |
| `ORIENTATION` | Right object, wrong way around | Pose-aware CV check fails, or worker confirmation prompt fails | Guide bearing chamfered edge facing outboard instead of inboard |
| `OMITTED_OBJECT` | Required object not present | CV doesn't detect a required object after `minDwellMs` threshold | Depth gauge not visible at S05 Verify Depth entry |
| `EXTRA_OBJECT` | Forbidden object present | CV detects an object in step's `forbidden_objects` list | Torque wrench visible during S07 Shim Pack selection — wrong tool |

## C. Specification errors — measurements and values

| Code | Definition | Detection mechanism | Pinion Guide example |
|---|---|---|---|
| `OUT_OF_SPEC` | Measured value outside acceptance range | OEM or worker-entered measurement compared to procedure spec | Pinion nut torque = 195 Nm, spec is 210–240 Nm |
| `UNVERIFIED` | Required measurement never taken | No measurement event logged within step duration | S05 closed without depth-gauge reading recorded |
| `BORDERLINE` | Within spec but near tolerance edge | Measurement compared to procedure spec ± epsilon | Press depth at 0.0048 mm — within 0.000–0.005 mm spec but at upper edge |

## D. Intent-vs-reality errors — *only detectable via OEM-signal fusion*

| Code | Definition | Detection mechanism | Pinion Guide example |
|---|---|---|---|
| `INTENT_MISMATCH` | OEM says step N, CV observes step M (≠ N±1) | `DIVERGED` transition sustained beyond threshold | OEM reports worker on S07 Shim, CV sees torque-nut actions (S09 signature) |
| `PHANTOM_PROGRESS` | OEM advanced but CV sees no work | `OEM_AHEAD_OF_CV` transition persists past expected dwell minimum | OEM marked S07 complete but CV never observed a shim package |
| `UNREPORTED_PROGRESS` | CV sees completion, OEM not updated | `CV_AHEAD_OF_OEM` transition; OEM state remains stuck | Worker did rotational torque check (S10) but didn't scan the traveler |
| `STATE_REPAIR` | Worker recognized own error and is fixing it | `BACKWARD` transition followed by re-entry into corrected state | Worker realizes wrong shim, removes it, restarts S07 with correct SKU |

## E. System / perception errors — *agent limitations, not worker errors*

| Code | Definition | Detection mechanism | Pinion Guide example |
|---|---|---|---|
| `CV_UNCERTAIN` | CV confidence below threshold | Aggregate confidence < 0.5 sustained for > 2 s | Hand occlusion during press operation — should hold proactive interventions |
| `STATE_AMBIGUOUS` | Multiple FSM states equally plausible | Top-2 candidate states within probability epsilon | Mid-procedure pause looks identical between S05 and S06 — use OEM signal to disambiguate |
| `OEM_UNAVAILABLE` | OEM signal stale or missing | No OEM transition event for > expected step duration upper bound | MSSQL polling timeout — fall back to CV-only inference, flag reduced confidence |
| `OUT_OF_DISTRIBUTION` | CV detects unknown object class | Detection class not in any state's expected vocabulary | Unfamiliar replacement tool on bench — investigate or flag for retraining |

---

## Architectural note

Groups **A–B** derive from Assembly101's mistake taxonomy (Sener et al., CVPR 2022). Group **C** extends it with measurement / specification errors common in industrial procedures. **Group D is architecturally unique to OEM-fusion systems** — these errors are undetectable by pure-CV (no comparison signal) or pure-OEM (no observation signal) systems, only by the fusion of both. Group **E** captures system-side perception limits, scored separately in eval to avoid polluting worker-error metrics.

## Eval implication

Reports decompose catch rate by error type. **Headline metric: high-priority error catch rate** — the catch rate restricted to errors tagged `high_priority` in each KeyStep's `errorProfile`. The per-step `errorProfile` in the procedure spec declares which error types are `high_priority`, `medium_priority`, `low_priority`, or `not_applicable` at that step. Reduces false positives by skipping checks irrelevant to the current state.

---

*Aequilibrium, Inc. / Omnia • Pilot: Comer Industries Pinion Guide Station PG-04 • Hardware: Rokid AI Glasses*
