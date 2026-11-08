import type { SchemaSnapshot } from "@typed-sql/schema";
import { nativeSignatures } from "./catalog/generated/native.js";
import type { Statement } from "./parser/types.js";
import { analyzePostgresSemantics as analyze } from "./semantics-engine.js";
export function analyzePostgresSemantics(statement: Statement, snapshot: SchemaSnapshot) {
  return analyze(statement, snapshot, nativeSignatures);
}
