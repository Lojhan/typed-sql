// Generated from pinned declarations and reviewed native contexts; run sqlserver:vocabulary:generate.
// See SQLSERVER_VOCABULARY_NOTICE and grammar/sqlserver/vocabulary/.
import { createSqlServerVocabulary } from "../vocabulary.js";
import { commonWords, contexts } from "./common.js";

const common = createSqlServerVocabulary(commonWords, [], contexts);
const scopes = new Map([
  ["14/140", common],
  ["15/140", common],
  ["15/150", common],
  ["16/140", common],
  ["16/150", common],
  ["16/160", common],
  ["17/140", common],
  ["17/150", common],
  ["17/160", common],
  ["17/170", createSqlServerVocabulary(commonWords, [["regexp_like", 64]], contexts)],
]);
export const sqlServerVocabulary = (major: number, compatibilityLevel: number) =>
  scopes.get(`${major}/${compatibilityLevel}`);
