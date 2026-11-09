import { createMySqlDialect } from "./analysis-factory.js";
import { defaultMySqlCatalog } from "./catalog/index.js";
import type { MySqlProfileOptions as MySqlDialectOptions } from "./profile.js";
import { parseMySqlVersion as vocabularyVersion } from "./support.js";
import { mySqlVocabulary } from "./vocabulary/index.js";
export function mysql(options: MySqlDialectOptions = {}) {
  return createMySqlDialect(defaultMySqlCatalog, options, undefined, false, (snapshot) => {
    const version = vocabularyVersion(snapshot.server?.versionKey ?? snapshot.version ?? "8.4.0");
    return version === undefined ? undefined : mySqlVocabulary(`${version[0]}.${version[1]}`);
  });
}
