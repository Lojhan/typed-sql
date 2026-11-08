import type { DialectAnalysis } from "@typed-sql/core";
import { duckDBCatalogForVersion } from "./catalog/index.js";
import type { DuckDBType } from "./native-types.js";
import type { Statement } from "./parser/types.js";
import { commonDuckDBType as common, DuckDBResolver as Resolver } from "./resolver-engine.js";
import type { DuckDBSchemaSnapshot } from "./snapshot.js";
import type { DuckDBTypePolicy } from "./type-policy.js";
export function commonDuckDBType(
  a: DuckDBType,
  b: DuckDBType,
  version = "2.0.0",
  mode: "expression" | "set" = "expression",
) {
  return common(a, b, duckDBCatalogForVersion(version), mode);
}
export class DuckDBResolver extends Resolver {
  constructor(snapshot: DuckDBSchemaSnapshot, policy: DuckDBTypePolicy) {
    super(snapshot, policy, duckDBCatalogForVersion(snapshot.server?.versionKey ?? ""));
  }
}
export function resolveDuckDBStatement(
  statement: Statement,
  snapshot: DuckDBSchemaSnapshot,
  policy: DuckDBTypePolicy,
): DialectAnalysis {
  return new DuckDBResolver(snapshot, policy).analyze(statement);
}
