// Generated from hash-locked PostgreSQL kwlist.h declarations; run postgres:vocabulary:refresh.
// See POSTGRES_VOCABULARY_NOTICE and grammar/postgres/vocabulary/sources.json.
import type { PostgresKeywordDeclaration } from "../types.js";
import { createPostgresVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [
  ["absent", "UNRESERVED_KEYWORD", true, "ABSENT"],
  ["conditional", "UNRESERVED_KEYWORD", true, "CONDITIONAL"],
  ["empty", "UNRESERVED_KEYWORD", true, "EMPTY_P"],
  ["error", "UNRESERVED_KEYWORD", true, "ERROR_P"],
  ["format", "UNRESERVED_KEYWORD", true, "FORMAT"],
  ["indent", "UNRESERVED_KEYWORD", true, "INDENT"],
  ["json", "COL_NAME_KEYWORD", true, "JSON"],
  ["json_array", "COL_NAME_KEYWORD", true, "JSON_ARRAY"],
  ["json_arrayagg", "COL_NAME_KEYWORD", true, "JSON_ARRAYAGG"],
  ["json_exists", "COL_NAME_KEYWORD", true, "JSON_EXISTS"],
  ["json_object", "COL_NAME_KEYWORD", true, "JSON_OBJECT"],
  ["json_objectagg", "COL_NAME_KEYWORD", true, "JSON_OBJECTAGG"],
  ["json_query", "COL_NAME_KEYWORD", true, "JSON_QUERY"],
  ["json_scalar", "COL_NAME_KEYWORD", true, "JSON_SCALAR"],
  ["json_serialize", "COL_NAME_KEYWORD", true, "JSON_SERIALIZE"],
  ["json_table", "COL_NAME_KEYWORD", true, "JSON_TABLE"],
  ["json_value", "COL_NAME_KEYWORD", true, "JSON_VALUE"],
  ["keep", "UNRESERVED_KEYWORD", true, "KEEP"],
  ["keys", "UNRESERVED_KEYWORD", true, "KEYS"],
  ["matched", "UNRESERVED_KEYWORD", true, "MATCHED"],
  ["merge", "UNRESERVED_KEYWORD", true, "MERGE"],
  ["merge_action", "COL_NAME_KEYWORD", true, "MERGE_ACTION"],
  ["nested", "UNRESERVED_KEYWORD", true, "NESTED"],
  ["omit", "UNRESERVED_KEYWORD", true, "OMIT"],
  ["parameter", "UNRESERVED_KEYWORD", true, "PARAMETER"],
  ["path", "UNRESERVED_KEYWORD", true, "PATH"],
  ["plan", "UNRESERVED_KEYWORD", true, "PLAN"],
  ["quotes", "UNRESERVED_KEYWORD", true, "QUOTES"],
  ["recheck", "UNRESERVED_KEYWORD", true, "RECHECK"],
  ["scalar", "UNRESERVED_KEYWORD", true, "SCALAR"],
  ["source", "UNRESERVED_KEYWORD", true, "SOURCE"],
  ["string", "UNRESERVED_KEYWORD", true, "STRING_P"],
  ["system_user", "RESERVED_KEYWORD", true, "SYSTEM_USER"],
  ["target", "UNRESERVED_KEYWORD", true, "TARGET"],
  ["unconditional", "UNRESERVED_KEYWORD", true, "UNCONDITIONAL"],
] as const satisfies readonly PostgresKeywordDeclaration[];
export const vocabulary = createPostgresVocabulary(commonKeywords, local);
export const source = {
  version: "17.11",
  digest: "sha256:8fa117aec8410d483c9fb9e711b1fea7cefc4acc1483c13af40fd24cbd4470bf",
  wordsDigest: "sha256:9653484b8d9b3a1501d52da91666ba1133ccc603d3c20b9162c92ba2270e59c5",
} as const;
