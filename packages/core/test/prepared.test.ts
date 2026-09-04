import { describe, it, strict } from "poku";
import { type PreparedQueryRenderCache, type RenderedQuery, registerPreparedQuery, sql } from "../src/index.js";

interface Metadata {
  readonly statementName: string;
  readonly rendered: RenderedQuery;
  readonly owner?: string;
}
const renderer = { placeholder: () => "?", quoteIdentifier: (name: string) => name };
const state = () => ({
  variantCapacity: 1,
  statements: new Map<string, { readonly variants: PreparedQueryRenderCache }>(),
  queries: new WeakMap<object, Metadata>(),
});

await describe("prepared-query registration", async () => {
  await it("retains query identity, parameter values, adapter metadata, and first-owner rules", () => {
    const registry = state();
    const query = sql`SELECT ${1}`;
    let metadataCalls = 0;
    const prepared = registerPreparedQuery({
      state: registry,
      renderer,
      statementName: "logical",
      factory: () => query,
      ownerName: (metadata) => metadata.owner!,
      metadata: ({ rendered }) => {
        metadataCalls += 1;
        return { statementName: "physical", owner: "logical", rendered };
      },
    });
    strict.strictEqual(prepared(), query);
    strict.strictEqual(prepared(), query);
    strict.strictEqual(prepared.statementName, "logical");
    strict.strictEqual(metadataCalls, 1);
    strict.ok(Object.isFrozen(prepared));
    strict.deepStrictEqual(registry.queries.get(query)?.rendered.values, [1]);
    const other = registerPreparedQuery({
      state: registry,
      renderer,
      statementName: "other",
      factory: () => query,
      metadata: ({ rendered }) => ({ statementName: "other", rendered }),
    });
    strict.throws(other, /cannot use both prepared statement "physical" and "other"/);
  });

  await it("validates registration before reserving names and rejects changed SQL structures", () => {
    const registry = state();
    let expanded = false;
    const options = {
      state: registry,
      renderer,
      statementName: "query",
      factory: () => (expanded ? sql`SELECT 2` : sql`SELECT 1`),
      metadata: ({ rendered }: { readonly rendered: RenderedQuery }) => ({ statementName: "query", rendered }),
    };
    for (const statementName of ["", "bad\0name"])
      strict.throws(() => registerPreparedQuery({ ...options, statementName }), /non-empty/);
    strict.strictEqual(registry.statements.size, 0);
    const prepared = registerPreparedQuery(options);
    prepared();
    strict.throws(() => registerPreparedQuery(options), /already registered/);
    strict.throws(
      () => registerPreparedQuery({ ...options, statementName: "second", capacity: { maximum: 1, message: "full" } }),
      /full/,
    );
    expanded = true;
    strict.throws(prepared, /same SQL text and structure/);
    const fixed = sql`SELECT 3`;
    const reusable = registerPreparedQuery({
      ...options,
      state: state(),
      factory: () => fixed,
      capacity: { maximum: 1, message: "full" },
    });
    strict.strictEqual(reusable(), reusable());
  });
});
