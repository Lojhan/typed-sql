import { vocabulary as pg14 } from "./generated/14.js";
import { vocabulary as pg15 } from "./generated/15.js";
import { vocabulary as pg16 } from "./generated/16.js";
import { vocabulary as pg17 } from "./generated/17.js";
import { vocabulary as pg18 } from "./generated/18.js";
import { vocabulary as pg19 } from "./generated/19.js";
import type { PostgresVocabulary } from "./types.js";

const versions = new Map([
  [14, pg14],
  [15, pg15],
  [16, pg16],
  [17, pg17],
  [18, pg18],
  [19, pg19],
]);

/** Compatibility analyzer selection. Selected cores import their exact generated module directly. */
export function postgresVocabulary(major = 18): PostgresVocabulary | undefined {
  return versions.get(major);
}
