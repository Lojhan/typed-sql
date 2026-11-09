// Generated from hash-locked PostgreSQL kwlist.h declarations; run postgres:vocabulary:refresh.
// See POSTGRES_VOCABULARY_NOTICE and grammar/postgres/vocabulary/sources.json.
import type { PostgresKeywordDeclaration } from "../types.js";
import { createPostgresVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [
  ["recheck", "UNRESERVED_KEYWORD", true, "RECHECK"],
] as const satisfies readonly PostgresKeywordDeclaration[];
export const vocabulary = createPostgresVocabulary(commonKeywords, local);
export const source = {
  version: "14.24",
  digest: "sha256:0791809f1c10761f76450c935710b47261a991d35adab212ddb888a958053548",
  wordsDigest: "sha256:4ed38f26cad0f1ae5ea6b4cc57392e4c0b5b7188542d105d927a50a0b6243f2c",
} as const;
