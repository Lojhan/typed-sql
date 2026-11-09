import { compareSqliteVersions, parseSqliteVersion } from "../support.js";
import { profiles } from "./generated/profiles.js";
import type { SqliteVocabulary } from "./types.js";

/** Minor-boundary source profiles preserve native rule transitions; exact pinned patches win. */
export function sqliteVocabulary(version?: string): SqliteVocabulary {
  const actual = version === undefined ? undefined : parseSqliteVersion(version);
  if (actual === undefined) return profiles[0][1];
  let selected: SqliteVocabulary = profiles[0][1];
  for (const [boundary, vocabulary] of profiles) {
    if (compareSqliteVersions(actual, parseSqliteVersion(boundary)!) < 0) break;
    selected = vocabulary;
  }
  return selected;
}
