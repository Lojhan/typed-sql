import { createPostgresDialect } from "../../analysis-factory.js";
import type { PostgresDialectOptions } from "../../analysis-options.js";
import catalog from "../../catalog/generated/15.js";
import { createPostgresCatalogProvider } from "../../catalog/provider.js";
import { createPostgresTypeResolver } from "../../type-resolution-factory.js";
import { vocabulary } from "../../vocabulary/generated/15.js";

export type { PostgresDialectOptions as PostgresCoreOptions } from "../../analysis-options.js";

const owner = createPostgresCatalogProvider([catalog], 15);
const types = createPostgresTypeResolver(owner);
export function postgres(options: PostgresDialectOptions = {}) {
  return createPostgresDialect(owner, types, options, 15, true, () => vocabulary.lookup);
}
