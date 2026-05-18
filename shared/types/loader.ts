/**
 * loader — read + validate the YAML specs.
 *
 * Used by:
 *   - eval-lab (browser)   → fetch('/spec/procedure') against backend
 *   - backend              → fs.readFileSync at boot
 *   - apk-bridge (codegen) → reads YAML and emits Kotlin data classes
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { ProcedureSpecSchema, type ProcedureSpec } from "./procedure";
import { TaxonomySchema, type Taxonomy } from "./taxonomy";
import { HardwareProfilesSchema, type HardwareProfiles } from "./hardware";
import { StrategiesSchema, type Strategies } from "./strategy";

const SHARED_ROOT = join(__dirname, "..");

function loadYaml<T>(relPath: string): unknown {
  const p = join(SHARED_ROOT, relPath);
  const raw = readFileSync(p, "utf8");
  return YAML.parse(raw);
}

export function loadProcedure(file = "procedure-spec/pinion-guide.yaml"): ProcedureSpec {
  return ProcedureSpecSchema.parse(loadYaml(file));
}

export function loadTaxonomy(file = "error-taxonomy/taxonomy.yaml"): Taxonomy {
  return TaxonomySchema.parse(loadYaml(file));
}

export function loadHardware(file = "hardware-profiles/profiles.yaml"): HardwareProfiles {
  return HardwareProfilesSchema.parse(loadYaml(file));
}

export function loadStrategies(file = "context-strategies/strategies.yaml"): Strategies {
  return StrategiesSchema.parse(loadYaml(file));
}

export interface PlatformSpec {
  procedure: ProcedureSpec;
  taxonomy: Taxonomy;
  hardware: HardwareProfiles;
  strategies: Strategies;
}

export function loadAll(): PlatformSpec {
  return {
    procedure: loadProcedure(),
    taxonomy: loadTaxonomy(),
    hardware: loadHardware(),
    strategies: loadStrategies(),
  };
}
