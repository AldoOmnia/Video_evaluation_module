/**
 * Loads + validates the shared YAML specs once at boot. The result is
 * frozen and re-used by every route.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { ProcedureSpecSchema } from "../../../shared/types/procedure.js";
import { TaxonomySchema } from "../../../shared/types/taxonomy.js";
import { HardwareProfilesSchema } from "../../../shared/types/hardware.js";
import { StrategiesSchema } from "../../../shared/types/strategy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, "..", "..", "..", "shared");

function read(rel: string): unknown {
  return YAML.parse(readFileSync(join(SHARED, rel), "utf8"));
}

export const specs = Object.freeze({
  procedure: ProcedureSpecSchema.parse(
    read("procedure-spec/pinion-guide.yaml"),
  ),
  taxonomy: TaxonomySchema.parse(read("error-taxonomy/taxonomy.yaml")),
  hardware: HardwareProfilesSchema.parse(read("hardware-profiles/profiles.yaml")),
  strategies: StrategiesSchema.parse(read("context-strategies/strategies.yaml")),
});

export type LoadedSpecs = typeof specs;
