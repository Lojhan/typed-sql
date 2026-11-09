// Generated from hash-locked MySQL lexical and grammar declarations; run mysql:vocabulary:refresh.
// See MYSQL_VOCABULARY_NOTICE and grammar/mysql/vocabulary/sources.json.
import type { MySqlKeywordDeclaration } from "../types.js";
import { createMySqlVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [
  ["ABSENT", 0],
  ["ALLOW_MISSING_FILES", 0],
  ["APPLIER_EVENT_MEMORY_LIMIT", 0],
  ["APPLIER_VERSION", 0],
  ["APPLIER_WORKER_COUNT", 0],
  ["AUTO_REFRESH", 0],
  ["AUTO_REFRESH_SOURCE", 0],
  ["DUALITY", 0],
  ["EXTERNAL", 1],
  ["EXTERNAL_FORMAT", 0],
  ["FILES", 0],
  ["FILE_FORMAT", 0],
  ["FILE_NAME", 0],
  ["FILE_PATTERN", 0],
  ["FILE_PREFIX", 0],
  ["GUIDED", 0],
  ["HEADER", 0],
  ["JSON_DUALITY_OBJECT", 10],
  ["LIBRARY", 1],
  ["MASKING", 0],
  ["MATERIALIZED", 0],
  ["PARAMETERS", 0],
  ["POLICY", 0],
  ["RELATIONAL", 0],
  ["SETS", 0],
  ["STRICT_LOAD", 0],
  ["URI", 0],
  ["VALIDATE", 0],
  ["VECTOR", 0],
  ["VERIFY_KEY_CONSTRAINTS", 0],
] as const satisfies readonly MySqlKeywordDeclaration[];
export const vocabulary = createMySqlVocabulary(commonKeywords, local);
export const source = {
  version: "26.7.0",
  digest: "sha256:b62601fb20683a4d0539cc9247639e6b6b08d53fa798621381e9ce96708a0674",
} as const;
