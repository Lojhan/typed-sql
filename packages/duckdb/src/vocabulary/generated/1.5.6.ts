// Generated from hash-pinned DuckDB declarations; run duckdb:vocabulary:refresh.
// See DUCKDB_VOCABULARY_NOTICE and grammar/duckdb/vocabulary/sources.json.
import { createDuckDBVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

export const vocabulary = createDuckDBVocabulary(
  commonKeywords,
  [
    ["columns", "CT"],
    ["generated", "CF"],
    ["map", "CF"],
    ["struct", "CF"],
    ["try_cast", "CT"],
  ],
  [],
  [
    "cast",
    "coalesce",
    "columns",
    "extract",
    "grouping",
    "grouping_id",
    "nullif",
    "overlay",
    "position",
    "row",
    "substring",
    "treat",
    "trim",
    "try_cast",
    "unpack",
  ],
  "UF",
);
