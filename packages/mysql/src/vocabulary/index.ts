import { vocabulary as mysql84 } from "./generated/8.4.js";
import { vocabulary as mysql97 } from "./generated/9.7.js";
import { vocabulary as mysql267 } from "./generated/26.7.js";
import type { MySqlVocabulary } from "./types.js";

const series = new Map([
  ["8.4", mysql84],
  ["9.7", mysql97],
  ["26.7", mysql267],
]);
/** Compatibility selection only; selected owners import one generated series directly. */
export function mySqlVocabulary(key = "8.4"): MySqlVocabulary | undefined {
  return series.get(key);
}
