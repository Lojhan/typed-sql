import { describe, it, strict } from "poku";
import {
  type QueryResults,
  QueryResultValidationError,
  type StandardSchemaV1,
  sql,
  validateQueryResultBatch,
} from "../src/index.js";

type Row = { readonly id: number };
function validated(validate: StandardSchemaV1<unknown, Row>["~standard"]["validate"]) {
  const schema: StandardSchemaV1<unknown, Row> = {
    "~standard": { version: 1, vendor: "batch-test", validate },
  };
  return sql.validateResult(sql<Row>`SELECT id`, schema);
}

await describe("ordered batch result validation", async () => {
  await it("preserves unvalidated and empty result identity without fingerprint work", async () => {
    const queries = [sql<Row>`SELECT id`, sql<{ name: string }>`SELECT name`] as const;
    const rows: QueryResults<typeof queries> = [[{ id: 1 }], [{ name: "a" }]];
    const unexpected = () => {
      throw new Error("fingerprint should be lazy");
    };
    strict.strictEqual(await validateQueryResultBatch(queries, rows, unexpected), rows);
    const empty = [] as const;
    strict.strictEqual(await validateQueryResultBatch([], empty, unexpected), empty);
  });

  await it("copies only the outer tuple and validated rows, and awaits each validator", async () => {
    const events: string[] = [];
    const query = validated(async (value) => {
      const row = value as Row;
      events.push(`start:${row.id}`);
      await Promise.resolve();
      events.push(`end:${row.id}`);
      return { value: { id: row.id + 1 } };
    });
    const ordinary = sql<{ name: string }>`SELECT name`;
    const queries = [query, ordinary, query] as const;
    const rows: QueryResults<typeof queries> = [[{ id: 1 }], [{ name: "a" }], [{ id: 2 }]];
    let fingerprints = 0;
    const result = await validateQueryResultBatch(queries, rows, () => {
      fingerprints++;
      return "test";
    });
    const typed: readonly [readonly Row[], readonly { name: string }[], readonly Row[]] = result;
    strict.notStrictEqual(result, rows);
    strict.strictEqual(typed[1], rows[1]);
    strict.deepStrictEqual(result, [[{ id: 2 }], [{ name: "a" }], [{ id: 3 }]]);
    strict.deepStrictEqual(rows[0], [{ id: 1 }]);
    strict.deepStrictEqual(events, ["start:1", "end:1", "start:2", "end:2"]);
    strict.strictEqual(fingerprints, 2);
    const array: readonly Row[][] = [[{ id: 4 }]];
    const queryArray = [query];
    const homogeneous: readonly (readonly Row[])[] = await validateQueryResultBatch(queryArray, array, () => "array");
    strict.deepStrictEqual(homogeneous, [[{ id: 5 }]]);
  });

  await it("stops at the first failed validator with its fingerprint and row index", async () => {
    const query = validated(() => ({ issues: [{ message: "invalid" }] }));
    const later = validated(() => {
      throw new Error("must not run");
    });
    await strict.rejects(
      () => validateQueryResultBatch([query, later], [[{ id: 1 }], [{ id: 2 }]], () => "first"),
      (error: unknown) =>
        error instanceof QueryResultValidationError && error.fingerprint === "first" && error.rowIndex === 0,
    );
    const failure = new Error("fingerprint failure");
    await strict.rejects(
      () =>
        validateQueryResultBatch([query], [[{ id: 1 }]], () => {
          throw failure;
        }),
      (error: unknown) => error === failure,
    );
  });
});
