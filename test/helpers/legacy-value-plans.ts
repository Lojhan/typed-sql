import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import {
  type Database,
  type Query,
  type QueryStream,
  QueryValueError,
  type StandardSchemaV1,
  sql,
  withQueryValuePlan,
} from "@typed-sql/core";
import { strict } from "poku";
import { compileSource } from "../../packages/compiler/src/index.js";

type Row = { doc: readonly number[] };
type PlannedQuery = Query<Row, readonly unknown[]>;
interface PlannedDatabase extends Pick<Database, "all" | "execute" | "one" | "maybeOne"> {
  batch(queries: readonly [PlannedQuery, PlannedQuery]): Promise<unknown>;
  stream(query: PlannedQuery): QueryStream<Row>;
  prepare(name: string, factory: () => PlannedQuery): () => PlannedQuery;
  transaction<T>(
    run: (scope: Pick<Database, "all"> & { stream?(query: PlannedQuery): QueryStream<Row> }) => Promise<T>,
  ): Promise<T>;
}

/** One real-driver proof reused by the two existing database E2E lifecycles. */
export async function assertLegacyValuePlans(
  database: PlannedDatabase,
  dialect: "postgres" | "mysql",
  typePolicyHash: string,
  pipeline?: (queries: readonly [PlannedQuery, PlannedQuery]) => Promise<unknown>,
): Promise<void> {
  const json = { shape: { kind: "array", element: { kind: "number" } }, representation: "parsed" } as const;
  const query = (badOutput = false): PlannedQuery =>
    withQueryValuePlan(
      sql<Row>`SELECT CAST(${badOutput ? sql.json(["wrong"]) : sql.json([1, 2])} AS ${sql.raw(dialect === "postgres" ? "jsonb" : "json")}) AS doc`,
      {
        dialect,
        typePolicyHash,
        columns: [{ name: "doc", type: "unknown", nullable: false, json }],
        parameters: [
          {
            index: 1,
            type: "unknown",
            nullable: false,
            json: { shape: { kind: "unknown" }, representation: "parsed" },
          },
        ],
      },
    );
  const good = query();
  let validations = 0;
  const schema: StandardSchemaV1<unknown, Row> = {
    "~standard": {
      version: 1,
      vendor: "planned-boundary",
      validate(value) {
        validations++;
        strict.deepEqual(value, { doc: [1, 2] });
        return { value: value as Row };
      },
    },
  };
  await database.all(sql.validateResult(good, schema));
  strict.equal(validations, 1, "attached plans decode before exactly one Standard Schema validation");
  await strict.rejects(database.all(sql.validateResult(query(true), schema)), QueryValueError);
  strict.equal(validations, 1, "invalid planned values never reach the application validator");

  strict.deepEqual(await database.all(good), [{ doc: [1, 2] }]);
  strict.deepEqual(await database.all(good, { deadline: Date.now() + 30_000 }), [{ doc: [1, 2] }]);
  strict.deepEqual(await database.execute(good), [{ doc: [1, 2] }]);
  strict.deepEqual(await database.one(good), { doc: [1, 2] });
  strict.deepEqual(await database.maybeOne(good), { doc: [1, 2] });
  strict.deepEqual(await database.batch([good, good]), [[{ doc: [1, 2] }], [{ doc: [1, 2] }]]);
  const prepared = database.prepare("attached_value_plan", () => good);
  strict.deepEqual(await database.all(prepared()), [{ doc: [1, 2] }]);
  const streamed = [];
  for await (const row of database.stream(good)) streamed.push(row);
  strict.deepEqual(streamed, [{ doc: [1, 2] }]);
  await database.transaction(async (scope) => {
    strict.deepEqual(await scope.all(good), [{ doc: [1, 2] }]);
  });
  const bad = query(true);
  if (pipeline !== undefined) {
    strict.deepEqual(await pipeline([good, good]), [[{ doc: [1, 2] }], [{ doc: [1, 2] }]]);
    await strict.rejects(pipeline([good, bad]), QueryValueError);
  }
  for (const run of [
    () => database.all(bad),
    () => database.all(bad, { deadline: Date.now() + 30_000 }),
    () => database.execute(bad),
    () => database.one(bad),
    () => database.maybeOne(bad),
    () => database.batch([good, bad]),
    () => database.transaction((scope) => scope.all(bad)),
  ]) {
    await strict.rejects(run(), QueryValueError);
  }
  const caughtStreamFailure = () =>
    database.transaction(async (scope) => {
      if (scope.stream === undefined) throw new Error("Expected a transactional stream capability");
      const rejectedStream = scope.stream(bad);
      await strict.rejects(rejectedStream.next(), QueryValueError);
      await rejectedStream.close();
      if (dialect === "postgres") await strict.rejects(scope.all(good), /transaction|scope|Query value/u);
      else
        strict.deepEqual(
          await scope.all(good),
          [{ doc: [1, 2] }],
          "MySQL preserves recoverable conversion-error semantics",
        );
    });
  if (dialect === "postgres") await strict.rejects(caughtStreamFailure(), QueryValueError);
  else await caughtStreamFailure();
  const stream = database.stream(bad);
  await strict.rejects(stream.next(), QueryValueError);
  await stream.close();
  strict.deepEqual(await database.all(good), [{ doc: [1, 2] }], "failed planned stream leaves its pool usable");
}

/** Raw-text policies must preserve JSON numbers and distinguish JSON null from SQL NULL. */
export async function assertLegacyTextValuePlans(
  database: Pick<Database, "one">,
  dialect: "postgres" | "mysql",
  typePolicyHash: string,
): Promise<void> {
  const query = (literal: string): Query<{ doc: string | null }> =>
    withQueryValuePlan(
      sql<{
        doc: string | null;
      }>`SELECT CAST(${sql.raw(literal)} AS ${sql.raw(dialect === "postgres" ? "jsonb" : "json")}) AS doc`,
      {
        dialect,
        typePolicyHash,
        columns: [
          {
            name: "doc",
            type: "unknown",
            nullable: true,
            json: { shape: { kind: "unknown" }, representation: "text" },
          },
        ],
        parameters: [],
      },
    );
  strict.ok((await database.one(query("'{\"n\":9223372036854775807}'"))).doc?.includes("9223372036854775807"));
  strict.equal((await database.one(query("'null'"))).doc, "null");
  strict.equal((await database.one(query("NULL"))).doc, null);
}

/** Execute compiler-produced structural plans through a real database, not hand-authored metadata. */
export async function assertCompiledLegacyValuePlans<Snapshot extends SchemaSnapshot, Policy>(
  database: Pick<Database, "all">,
  dialect: DialectPlugin<Snapshot, Policy>,
  schema: Snapshot,
  directory: string,
): Promise<void> {
  const mysql = dialect.id === "mysql";
  const cast = mysql ? "CHAR" : "integer";
  const type = mysql ? "string" : "number";
  const source = [
    `import {sql} from ${JSON.stringify(dialect.runtimeSqlModule)};`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This string is application TypeScript source compiled below.
    "export function conditional(flag:boolean,value:VALUE_TYPE){return sql`SELECT CAST(${value} AS SQL_CAST) AS id${flag?sql.fragment`, 'chosen' AS label`:sql.empty}`;}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This string is application TypeScript source compiled below.
    "export function repeated(display:VALUE_TYPE,probe:VALUE_TYPE,values:readonly VALUE_TYPE[],flag:VALUE_TYPE){return sql`SELECT CAST(${display} AS SQL_CAST) AS id WHERE CAST(${probe} AS SQL_CAST) IN (${values.map(value=>sql.fragment`${value}`)}) AND CAST(${flag} AS SQL_CAST)=1`;}",
  ]
    .join("\n")
    .replaceAll("VALUE_TYPE", type)
    .replaceAll("SQL_CAST", cast);
  const compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
  strict.deepEqual(compiled.diagnostics, []);
  strict.equal(compiled.queries.length, 2);
  for (const query of compiled.queries)
    for (const choice of query.valuePlanChoices ?? [])
      strict.equal(choice.plan.columns[0]?.type, query.repeatedFragments === undefined ? type : "unknown");
  const temporary = await mkdtemp(join(directory, ".compiled-runtime-plans-"));
  try {
    const file = join(temporary, "queries.mts");
    await writeFile(file, compiled.transformedSource);
    const queries = (await import(pathToFileURL(file).href)) as {
      conditional(flag: boolean, value: number | string): Query<{ id: number | string; label?: string }>;
      repeated(
        display: number | string,
        probe: number | string,
        values: readonly (number | string)[],
        flag: number | string,
      ): Query<{ id: number | string }>;
    };
    const value = (n: number) => (mysql ? String(n) : n);
    strict.deepEqual(await database.all(queries.conditional(true, value(7))), [{ id: value(7), label: "chosen" }]);
    strict.deepEqual(await database.all(queries.conditional(false, value(8))), [{ id: value(8) }]);
    for (const count of [1, 2, 3, 7]) {
      strict.deepEqual(
        await database.all(
          queries.repeated(
            value(7),
            value(8),
            Array.from({ length: count }, (_, index) => value(8 + index)),
            value(1),
          ),
        ),
        [{ id: value(7) }],
      );
    }
    strict.throws(() => queries.repeated(value(7), value(8), [], value(1)), /empty interpolated array/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
