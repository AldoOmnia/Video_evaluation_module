/**
 * Generate Kotlin data classes from the shared YAML specs and drop them
 * into the comer-rokid-demo glasses-app source tree.
 *
 * Run:   npm run gen:apk
 * Override target with APK_PROJECT_ROOT env var.
 *
 * Output is hand-readable and deterministic — diff it in a PR before
 * letting it land on device.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { ProcedureSpecSchema, type ProcedureSpec } from "../shared/types/procedure.js";
import { TaxonomySchema, type Taxonomy } from "../shared/types/taxonomy.js";
import { HardwareProfilesSchema, type HardwareProfile } from "../shared/types/hardware.js";
import { StrategiesSchema, type ContextStrategy } from "../shared/types/strategy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SHARED = join(REPO, "shared");

const APK_ROOT =
  process.env.APK_PROJECT_ROOT ??
  join(
    REPO,
    "..",
    "comer-rokid-demo",
    "glasses-app",
    "app",
    "src",
    "main",
    "java",
    "com",
    "omnia",
    "comer",
    "spec",
  );

const PKG = "com.omnia.comer.spec";

function read<T>(rel: string, parser: { parse: (x: unknown) => T }): T {
  return parser.parse(YAML.parse(readFileSync(join(SHARED, rel), "utf8")));
}

function ktString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}
function ktList<T>(items: T[], fmt: (x: T) => string): string {
  return `listOf(${items.map(fmt).join(", ")})`;
}

function header(): string {
  return [
    `// AUTO-GENERATED from /shared/*.yaml — do not edit by hand.`,
    `// Run \`npm run gen:apk\` in the comer-rokid-platform repo to refresh.`,
    `package ${PKG}`,
    ``,
  ].join("\n");
}

function emitProcedure(p: ProcedureSpec): string {
  const steps = ktList(p.keysteps, (k) => {
    const ep = k.errorProfile;
    return [
      `KeyStep(`,
      `  id = ${ktString(k.id)},`,
      `  order = ${k.order},`,
      `  label = ${ktString(k.label)},`,
      `  description = ${ktString(k.description ?? "")},`,
      `  risk = Risk.${k.risk.toUpperCase()},`,
      `  acceptance = ${ktString(k.acceptance)},`,
      `  errorProfile = ErrorProfile(`,
      `    high = ${ktList(ep.high_priority, (c) => `ErrorCode.${c}`)},`,
      `    medium = ${ktList(ep.medium_priority, (c) => `ErrorCode.${c}`)},`,
      `    low = ${ktList(ep.low_priority, (c) => `ErrorCode.${c}`)},`,
      `    notApplicable = ${ktList(ep.not_applicable, (c) => `ErrorCode.${c}`)}`,
      `  )`,
      `)`,
    ].join("\n");
  });
  const tools = ktList(p.tools, (t) =>
    `Tool(${ktString(t.id)}, ${ktString(t.label)}, ${ktString(t.sku)})`,
  );
  const parts = ktList(p.parts, (pp) =>
    `Part(${ktString(pp.id)}, ${ktString(pp.label)}, ${ktString(pp.sku)})`,
  );
  const instructions = ktList(p.instructions, (i) =>
    `Instruction(${ktString(i.id)}, ${ktString(i.label)}, ${ktString(i.forStep)})`,
  );
  const advice = ktList(p.expertAdvice, (a) =>
    `ExpertAdvice(${ktString(a.id)}, ${ktString(a.label)}, ${ktString(a.forStep)}, ${ktString(a.source)})`,
  );

  return [
    header(),
    `enum class Risk { LOW, MED, HIGH }`,
    ``,
    `enum class ErrorCode {`,
    `  OMISSION, INSERTION, ORDER, INCOMPLETE,`,
    `  SUBSTITUTION, ORIENTATION, OMITTED_OBJECT, EXTRA_OBJECT,`,
    `  OUT_OF_SPEC, UNVERIFIED, BORDERLINE,`,
    `  INTENT_MISMATCH, PHANTOM_PROGRESS, UNREPORTED_PROGRESS, STATE_REPAIR,`,
    `  CV_UNCERTAIN, STATE_AMBIGUOUS, OEM_UNAVAILABLE, OUT_OF_DISTRIBUTION`,
    `}`,
    ``,
    `data class ErrorProfile(`,
    `  val high: List<ErrorCode>,`,
    `  val medium: List<ErrorCode>,`,
    `  val low: List<ErrorCode>,`,
    `  val notApplicable: List<ErrorCode>`,
    `)`,
    ``,
    `data class KeyStep(`,
    `  val id: String, val order: Int, val label: String, val description: String,`,
    `  val risk: Risk, val acceptance: String, val errorProfile: ErrorProfile`,
    `)`,
    ``,
    `data class Tool(val id: String, val label: String, val sku: String)`,
    `data class Part(val id: String, val label: String, val sku: String)`,
    `data class Instruction(val id: String, val label: String, val forStep: String)`,
    `data class ExpertAdvice(val id: String, val label: String, val forStep: String, val source: String)`,
    ``,
    `object PinionGuideProcedure {`,
    `  const val ID = ${ktString(p.proceduralActivity.id)}`,
    `  const val LABEL = ${ktString(p.proceduralActivity.label)}`,
    `  const val STATION = ${ktString(p.proceduralActivity.stationId)}`,
    `  const val CYCLE_MIN = ${p.proceduralActivity.cycleMin}`,
    `  val KEYSTEPS: List<KeyStep> = ${steps}`,
    `  val TOOLS: List<Tool> = ${tools}`,
    `  val PARTS: List<Part> = ${parts}`,
    `  val INSTRUCTIONS: List<Instruction> = ${instructions}`,
    `  val EXPERT_ADVICE: List<ExpertAdvice> = ${advice}`,
    `}`,
    ``,
  ].join("\n");
}

function emitHardware(profiles: Record<string, HardwareProfile>): string {
  const lines = Object.values(profiles).map((h) => {
    return [
      `HardwareProfile(`,
      `  id = ${ktString(h.id)},`,
      `  name = ${ktString(h.name)},`,
      `  hasCamera = ${h.signals.camera},`,
      `  hasDisplay = ${h.signals.display},`,
      `  hasEyeGaze = ${h.signals.eye_gaze},`,
      `  hasAudioIn = ${h.signals.audio_in},`,
      `  hasAudioOut = ${h.signals.audio_out},`,
      `  latencyBudgetMs = ${h.latency_budget_ms}`,
      `)`,
    ].join("\n");
  });
  return [
    header(),
    `data class HardwareProfile(`,
    `  val id: String, val name: String,`,
    `  val hasCamera: Boolean, val hasDisplay: Boolean, val hasEyeGaze: Boolean,`,
    `  val hasAudioIn: Boolean, val hasAudioOut: Boolean,`,
    `  val latencyBudgetMs: Int`,
    `)`,
    ``,
    `object HardwareProfiles {`,
    `  val ALL: List<HardwareProfile> = listOf(`,
    `    ${lines.join(",\n    ")}`,
    `  )`,
    `  val ROKID: HardwareProfile = ALL.first { it.id == "rokid_ai" }`,
    `}`,
    ``,
  ].join("\n");
}

function emitStrategies(strategies: Record<string, ContextStrategy>): string {
  const lines = Object.values(strategies).map(
    (s) =>
      `ContextStrategy(${ktString(s.id)}, ${ktString(s.name)}, ${ktString(s.desc)}, ${s.avg_input_tokens}, ${s.catch_rate_ideal}, ${s.fp_rate})`,
  );
  return [
    header(),
    `data class ContextStrategy(`,
    `  val id: String, val name: String, val desc: String,`,
    `  val avgInputTokens: Int, val catchRateIdeal: Double, val fpRate: Double`,
    `)`,
    ``,
    `object ContextStrategies {`,
    `  val ALL: List<ContextStrategy> = listOf(`,
    `    ${lines.join(",\n    ")}`,
    `  )`,
    `  val PRODUCTION: ContextStrategy = ALL.first { it.id == "tiered_proactive" }`,
    `}`,
    ``,
  ].join("\n");
}

function emitTaxonomy(t: Taxonomy): string {
  const errs = Object.entries(t.errors)
    .map(
      ([code, m]) =>
        `  ErrorCode.${code} to ErrorMeta(${ktString(m.group)}, ${ktString(m.label)}, ${ktString(m.desc)})`,
    )
    .join(",\n");
  return [
    header(),
    `data class ErrorMeta(val group: String, val label: String, val desc: String)`,
    ``,
    `object Taxonomy {`,
    `  val ERRORS: Map<ErrorCode, ErrorMeta> = mapOf(`,
    errs,
    `  )`,
    `}`,
    ``,
  ].join("\n");
}

function writeFile(file: string, content: string): void {
  const target = join(APK_ROOT, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  console.log(`wrote ${target} (${content.length} bytes)`);
}

function main(): void {
  const procedure = read("procedure-spec/pinion-guide.yaml", ProcedureSpecSchema);
  const taxonomy = read("error-taxonomy/taxonomy.yaml", TaxonomySchema);
  const hardware = read("hardware-profiles/profiles.yaml", HardwareProfilesSchema);
  const strategies = read("context-strategies/strategies.yaml", StrategiesSchema);

  if (!existsSync(dirname(APK_ROOT))) {
    console.warn(
      `[gen:apk] APK project not found at ${APK_ROOT}\n` +
        `          Set APK_PROJECT_ROOT to override, or skip this step.`,
    );
    return;
  }

  writeFile("PinionGuideProcedure.kt", emitProcedure(procedure));
  writeFile("Taxonomy.kt", emitTaxonomy(taxonomy));
  writeFile("HardwareProfile.kt", emitHardware(hardware.profiles));
  writeFile("ContextStrategy.kt", emitStrategies(strategies.strategies));
  console.log("[gen:apk] done");
}

main();
