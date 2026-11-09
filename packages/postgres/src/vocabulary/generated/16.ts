// Generated from hash-locked PostgreSQL kwlist.h declarations; run postgres:vocabulary:refresh.
// See POSTGRES_VOCABULARY_NOTICE and grammar/postgres/vocabulary/sources.json.
import type { PostgresKeywordDeclaration } from "../types.js";
import { createPostgresVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [
  ["absent", "UNRESERVED_KEYWORD", true, "ABSENT"],
  ["format", "UNRESERVED_KEYWORD", true, "FORMAT"],
  ["indent", "UNRESERVED_KEYWORD", true, "INDENT"],
  ["json", "UNRESERVED_KEYWORD", true, "JSON"],
  ["json_array", "COL_NAME_KEYWORD", true, "JSON_ARRAY"],
  ["json_arrayagg", "COL_NAME_KEYWORD", true, "JSON_ARRAYAGG"],
  ["json_object", "COL_NAME_KEYWORD", true, "JSON_OBJECT"],
  ["json_objectagg", "COL_NAME_KEYWORD", true, "JSON_OBJECTAGG"],
  ["keys", "UNRESERVED_KEYWORD", true, "KEYS"],
  ["matched", "UNRESERVED_KEYWORD", true, "MATCHED"],
  ["merge", "UNRESERVED_KEYWORD", true, "MERGE"],
  ["parameter", "UNRESERVED_KEYWORD", true, "PARAMETER"],
  ["recheck", "UNRESERVED_KEYWORD", true, "RECHECK"],
  ["scalar", "UNRESERVED_KEYWORD", true, "SCALAR"],
  ["system_user", "RESERVED_KEYWORD", true, "SYSTEM_USER"],
] as const satisfies readonly PostgresKeywordDeclaration[];
export const vocabulary = createPostgresVocabulary(commonKeywords, local);
export const source = {
  version: "16.15",
  digest: "sha256:b9db8bdeecc085e015e6e958a53545ebe0d8fbadf1094bc885ae511d32ace819",
  wordsDigest: "sha256:e635c3ed50e6ffe4a69f24b88ca513c976e01fbddfe35a49622238917066633c",
} as const;
