// Generated from hash-locked PostgreSQL kwlist.h declarations; run postgres:vocabulary:refresh.
// See POSTGRES_VOCABULARY_NOTICE and grammar/postgres/vocabulary/sources.json.
import type { PostgresKeywordDeclaration } from "../types.js";
import { createPostgresVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [
  ["absent", "UNRESERVED_KEYWORD", true, "ABSENT"],
  ["conditional", "UNRESERVED_KEYWORD", true, "CONDITIONAL"],
  ["empty", "UNRESERVED_KEYWORD", true, "EMPTY_P"],
  ["enforced", "UNRESERVED_KEYWORD", true, "ENFORCED"],
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
  ["objects", "UNRESERVED_KEYWORD", true, "OBJECTS_P"],
  ["omit", "UNRESERVED_KEYWORD", true, "OMIT"],
  ["parameter", "UNRESERVED_KEYWORD", true, "PARAMETER"],
  ["path", "UNRESERVED_KEYWORD", true, "PATH"],
  ["period", "UNRESERVED_KEYWORD", true, "PERIOD"],
  ["plan", "UNRESERVED_KEYWORD", true, "PLAN"],
  ["quotes", "UNRESERVED_KEYWORD", true, "QUOTES"],
  ["scalar", "UNRESERVED_KEYWORD", true, "SCALAR"],
  ["source", "UNRESERVED_KEYWORD", true, "SOURCE"],
  ["string", "UNRESERVED_KEYWORD", true, "STRING_P"],
  ["system_user", "RESERVED_KEYWORD", true, "SYSTEM_USER"],
  ["target", "UNRESERVED_KEYWORD", true, "TARGET"],
  ["unconditional", "UNRESERVED_KEYWORD", true, "UNCONDITIONAL"],
  ["virtual", "UNRESERVED_KEYWORD", true, "VIRTUAL"],
] as const satisfies readonly PostgresKeywordDeclaration[];
export const vocabulary = createPostgresVocabulary(commonKeywords, local);
export const source = {
  version: "18.6",
  digest: "sha256:fdcdf3694513cba63b4016f63032472b686e381bb35f17c5d645bc2f6f1dac16",
  wordsDigest: "sha256:dca109a7ba361b6341775f8e4ea2c2704369a328db34ea82fcdf546c2310cf71",
} as const;
