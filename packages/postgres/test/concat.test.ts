import { describe, it, strict } from "poku";
import { rowTypeLiteral } from "../../core/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import { postgresCatalogRoutineRule } from "../src/catalog/index.js";
import { parseSelect } from "../src/parser/index.js";
import { resolveSelect } from "../src/resolver.js";
import { defaultPostgresTypePolicy } from "../src/type-policy.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: {
        name: { name: "name", databaseType: "text", tsType: "string", nullable: true },
        id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
      },
    },
  },
} as const satisfies SchemaSnapshot;
const resolve = (sql: string) => resolveSelect(parseSelect(sql), schema);
await describe("PostgreSQL concat", async () => {
  await it("recognizes catalog names and ignores ordinary NULL inputs without narrowing arguments to text", () => {
    strict.equal(postgresCatalogRoutineRule("concat"), "concat");
    for (const name of ["concat", "CONCAT", "pg_catalog.concat", '"pg_catalog"."concat"']) {
      const result = resolve(
        `SELECT ${name}('abc', 2, NULL, true, name, id, '{}'::jsonb, ARRAY[1,2]) AS value FROM users`,
      );
      strict.deepEqual(result.diagnostics, []);
      strict.equal(rowTypeLiteral(result.columns), '{ "value": string; }');
      strict.equal(result.columns[0]?.databaseType, "text");
      strict.deepEqual(result.parameters, []);
    }
    strict.equal(rowTypeLiteral(resolve("SELECT concat(NULL,NULL) AS value").columns), '{ "value": string; }');
    strict.equal(rowTypeLiteral(resolve("SELECT concat(42) AS value").columns), '{ "value": string; }');
  });
  await it("preserves explicitly typed ordered parameters and the selected type policy", () => {
    const result = resolveSelect(parseSelect("SELECT concat($1::bigint,$2::numeric,$3::text) AS value"), schema, {
      typePolicy: { ...defaultPostgresTypePolicy, bigint: "string", numeric: "number" },
    });
    strict.deepEqual(result.diagnostics, []);
    strict.equal(rowTypeLiteral(result.columns), '{ "value": string; }');
    strict.deepEqual(
      result.parameters.map(({ index, tsType, databaseType }) => ({ index, tsType, databaseType })),
      [
        { index: 1, tsType: "string", databaseType: "bigint" },
        { index: 2, tsType: "number", databaseType: "numeric" },
        { index: 3, tsType: "string", databaseType: "text" },
      ],
    );
  });
  await it("does not invent polymorphic parameter context and reports its exact source span", () => {
    const sql = "SELECT concat('😀', $1) AS value",
      result = resolve(sql);
    strict.equal(result.columns[0]?.tsType, "unknown");
    strict.equal(result.parameters[0]?.tsType, "unknown");
    strict.equal(result.parameters[0]?.databaseType, undefined);
    const diagnostic = result.diagnostics.find(({ code }) => code === "TSQ202");
    strict.ok(diagnostic);
    strict.equal(sql.slice(diagnostic.range.start, diagnostic.range.end), "$1");
    strict.equal(diagnostic.range.column, sql.indexOf("$1") + 1);
    strict.ok(resolve("SELECT concat(missing) FROM users").diagnostics.some(({ code }) => code === "TSQ101"));
  });
  await it("rejects unsupported arity, VARIADIC and aggregate modifiers instead of promising nonnull output", () => {
    for (const sql of [
      "SELECT concat()",
      "SELECT concat(VARIADIC NULL::text[])",
      "SELECT concat(VARIADIC ARRAY['a','b'])",
      "SELECT concat(DISTINCT 'a')",
      "SELECT concat('a') OVER ()",
      "SELECT concat('a') FILTER (WHERE true)",
      "SELECT concat('a' ORDER BY 1)",
      "SELECT concat(value => 'a')",
    ]) {
      const result = resolve(sql);
      strict.equal(result.columns[0]?.tsType, "unknown", sql);
      strict.ok(
        result.diagnostics.some(({ code }) => code === "TSQ227"),
        sql,
      );
    }
  });
  await it("respects quoted names, explicit schemas and application-owned function signatures", () => {
    for (const sql of ['SELECT "CONCAT"(1)', "SELECT custom.concat(1)", "SELECT unknown_fn(1)"]) {
      const result = resolve(sql);
      strict.equal(result.columns[0]?.tsType, "unknown");
      strict.ok(result.diagnostics.some(({ code }) => code === "TSQ202"));
    }
    const result = resolveSelect(parseSelect("SELECT concat(1) AS value"), {
      ...schema,
      functions: {
        "concat(integer)": {
          name: "concat",
          argumentTypes: ["integer"],
          databaseReturnType: "integer",
          returnType: "number",
          nullable: true,
        },
      },
    });
    strict.deepEqual(result.diagnostics, []);
    strict.equal(rowTypeLiteral(result.columns), '{ "value": number | null; }');
  });
});
