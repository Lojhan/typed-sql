import { describe, it, strict } from "poku";
import {
  defineQuerySemantics,
  mapQuerySemanticRanges,
  mergeQuerySemantics,
  QUERY_SEMANTICS_VERSION,
  type QuerySemantics,
  unknownQuerySemantics,
} from "../src/index.js";

const firstRange = { start: 0, end: 6, line: 1, column: 1 } as const;

function semantics(operation: "read" | "write", maximum: 1 | "many"): QuerySemantics {
  const evidence = [{ kind: "syntax" as const, description: operation, range: firstRange }];
  return {
    version: QUERY_SEMANTICS_VERSION,
    operation: { value: operation, evidence },
    dependencies: [
      {
        kind: "relation",
        access: operation,
        name: operation === "read" ? "accounts" : "audit",
        certainty: "resolved",
        range: firstRange,
      },
    ],
    cardinality: { minimum: operation === "read" ? 1 : 0, maximum, evidence },
    volatility: { value: operation === "read" ? "stable" : "volatile", evidence },
    locking: { value: "none", evidence },
    connectionAffinity: { value: "none", evidence },
    capabilities: operation === "read" ? ["ctes"] : ["returning"],
  };
}

await describe("query semantics", async () => {
  await it("merges structural variants conservatively and deterministically", () => {
    const merged = mergeQuerySemantics([semantics("write", "many"), semantics("read", 1)]);
    strict.strictEqual(merged.operation.value, "unknown");
    strict.strictEqual(merged.cardinality.minimum, 0);
    strict.strictEqual(merged.cardinality.maximum, "many");
    strict.strictEqual(merged.volatility.value, "volatile");
    strict.deepStrictEqual(merged.capabilities, ["ctes", "returning"]);
    strict.deepStrictEqual(
      merged.dependencies.map(({ name }) => name),
      ["accounts", "audit"],
    );
    strict.deepStrictEqual(mergeQuerySemantics([semantics("write", "many"), semantics("read", 1)]), merged);
    strict.ok(Object.isFrozen(merged));
    strict.ok(Object.isFrozen(merged.dependencies));
    strict.ok(Object.isFrozen(merged.dependencies[0]));
    strict.ok(Object.isFrozen(merged.operation.evidence[0]?.range));
  });

  await it("maps every evidence and dependency range without mutating the grammar result", () => {
    const original = semantics("read", 1);
    const mapped = mapQuerySemanticRanges(original, (range) => ({
      ...range,
      start: range.start + 10,
      end: range.end + 10,
    }));
    strict.strictEqual(original.operation.evidence[0]?.range.start, 0);
    strict.strictEqual(mapped.operation.evidence[0]?.range.start, 10);
    strict.strictEqual(mapped.cardinality.evidence[0]?.range.start, 10);
    strict.strictEqual(mapped.dependencies[0]?.range.start, 10);
  });

  await it("represents unsupported analysis as explicit unknown evidence", () => {
    const unknown = unknownQuerySemantics(firstRange, "Unsupported statement");
    strict.strictEqual(unknown.operation.value, "unknown");
    strict.strictEqual(unknown.cardinality.maximum, "unknown");
    strict.strictEqual(unknown.volatility.value, "unknown");
    strict.strictEqual(unknown.locking.value, "unknown");
    strict.strictEqual(unknown.operation.evidence[0]?.kind, "conservative");
  });

  await it("rejects an empty structural merge", () => {
    strict.throws(() => mergeQuerySemantics([]), /At least one/);
    strict.throws(
      () => defineQuerySemantics({ ...semantics("read", 1), version: 2 as never }),
      /Unsupported query semantics version 2/,
    );
  });
});
