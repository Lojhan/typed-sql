import { legacyGenerationInput } from "../../tools/grammar-catalog/src/import/legacy.mjs";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { CATEGORIES } from "../language-audit/inventory.mjs";

export function targetSeries(dialect, version, registry = builtinMappers) {
  return registry.get(dialect).versionBand(version);
}

// Keep context-specific facts in the normalized graph and consume only its validated projections.
export function normalizedCorpus(corpus, registry = builtinMappers) {
  return legacyGenerationInput(corpus, registry, CATEGORIES);
}

export function groupCorpus(corpus, registry = builtinMappers) {
  return normalizedCorpus(corpus, registry).groups;
}

export { duckdbCombinations, duckdbSignature } from "../../tools/grammar-catalog/src/generate/facts/duckdb.mjs";
export {
  postgresCasts,
  postgresSignature,
  postgresTypes,
} from "../../tools/grammar-catalog/src/generate/facts/postgres.mjs";
