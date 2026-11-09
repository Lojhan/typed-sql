// Generated from hash-locked MySQL lexical and grammar declarations; run mysql:vocabulary:refresh.
// See MYSQL_VOCABULARY_NOTICE and grammar/mysql/vocabulary/sources.json.
import type { MySqlKeywordDeclaration } from "../types.js";
import { createMySqlVocabulary } from "../vocabulary.js";
import { commonKeywords } from "./common.js";

const local = [] as const satisfies readonly MySqlKeywordDeclaration[];
export const vocabulary = createMySqlVocabulary(commonKeywords, local);
export const source = {
  version: "8.4.11",
  digest: "sha256:d2029a500b7ed928c5606dca675abdb7a9fb69f8269071f1d772ba20693a6ed4",
} as const;
