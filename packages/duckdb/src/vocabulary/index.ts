import { vocabulary as v15 } from "./generated/1.5.6.js";
import { vocabulary as v20 } from "./generated/2.0.0.js";

/** Compatibility entrypoints select only exact, source-qualified engines. */
export function duckDBVocabulary(version: string) {
  return version === "1.5.6" ? v15 : version === "2.0.0" ? v20 : undefined;
}
