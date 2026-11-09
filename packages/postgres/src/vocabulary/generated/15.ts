// Generated from hash-locked PostgreSQL kwlist.h declarations; run postgres:vocabulary:refresh.
// See POSTGRES_VOCABULARY_NOTICE and grammar/postgres/vocabulary/sources.json.
import type { PostgresKeywordDeclaration } from "../types.js";
import { createPostgresVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [
  ["matched", "UNRESERVED_KEYWORD", true, "MATCHED"],
  ["merge", "UNRESERVED_KEYWORD", true, "MERGE"],
  ["parameter", "UNRESERVED_KEYWORD", true, "PARAMETER"],
  ["recheck", "UNRESERVED_KEYWORD", true, "RECHECK"],
] as const satisfies readonly PostgresKeywordDeclaration[];
export const vocabulary = createPostgresVocabulary(commonKeywords, local);
export const source = {
  version: "15.19",
  digest: "sha256:d33997e04d510308f64958549ba27e123ea0dff9dd98eab24952039821fcb40d",
  wordsDigest: "sha256:1c237c4fa508e8bc015fe988725a417d3606b0e102ccac5f4066160e4714c8a8",
} as const;
