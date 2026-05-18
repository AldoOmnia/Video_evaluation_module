/**
 * Boot-time sanity check. Reads every YAML spec under /shared and validates
 * it against its Zod schema. Exit non-zero if anything fails — so CI can
 * gate on `npm run validate`.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ZodError } from "zod";

import { ProcedureSpecSchema } from "../shared/types/procedure.js";
import { TaxonomySchema } from "../shared/types/taxonomy.js";
import { HardwareProfilesSchema } from "../shared/types/hardware.js";
import { StrategiesSchema } from "../shared/types/strategy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, "..", "shared");

const targets = [
  { file: "procedure-spec/pinion-guide.yaml", schema: ProcedureSpecSchema },
  { file: "error-taxonomy/taxonomy.yaml", schema: TaxonomySchema },
  { file: "hardware-profiles/profiles.yaml", schema: HardwareProfilesSchema },
  { file: "context-strategies/strategies.yaml", schema: StrategiesSchema },
];

let failures = 0;
for (const { file, schema } of targets) {
  const path = join(SHARED, file);
  if (!existsSync(path)) {
    console.error(`[FAIL] missing: ${file}`);
    failures++;
    continue;
  }
  try {
    schema.parse(YAML.parse(readFileSync(path, "utf8")));
    console.log(`[OK]   ${file}`);
  } catch (e) {
    failures++;
    console.error(`[FAIL] ${file}`);
    if (e instanceof ZodError) {
      for (const issue of e.issues) {
        console.error(`       ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      console.error(`       ${(e as Error).message}`);
    }
  }
}

// Cross-spec referential integrity
try {
  const procedure = ProcedureSpecSchema.parse(
    YAML.parse(readFileSync(join(SHARED, "procedure-spec/pinion-guide.yaml"), "utf8")),
  );
  const taxonomy = TaxonomySchema.parse(
    YAML.parse(readFileSync(join(SHARED, "error-taxonomy/taxonomy.yaml"), "utf8")),
  );
  const knownCodes = new Set(Object.keys(taxonomy.errors));

  for (const step of procedure.keysteps) {
    const buckets = {
      high_priority: step.errorProfile.high_priority,
      medium_priority: step.errorProfile.medium_priority,
      low_priority: step.errorProfile.low_priority,
      not_applicable: step.errorProfile.not_applicable,
    } as const;
    for (const [bucket, codes] of Object.entries(buckets)) {
      for (const c of codes) {
        if (!knownCodes.has(c)) {
          failures++;
          console.error(
            `[FAIL] ${step.id}.errorProfile.${bucket} references unknown code ${c}`,
          );
        }
      }
    }
  }

  const knownToolIds = new Set(procedure.tools.map((t) => t.id));
  const knownPartIds = new Set(procedure.parts.map((p) => p.id));
  for (const [stepId, req] of Object.entries(procedure.stepRequirements)) {
    for (const t of req.tools) {
      if (!knownToolIds.has(t)) {
        failures++;
        console.error(`[FAIL] ${stepId} requires unknown tool ${t}`);
      }
    }
    for (const p of req.parts) {
      if (!knownPartIds.has(p)) {
        failures++;
        console.error(`[FAIL] ${stepId} requires unknown part ${p}`);
      }
    }
  }
  if (failures === 0) console.log(`[OK]   referential integrity`);
} catch {
  // already reported above
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall specs valid`);
