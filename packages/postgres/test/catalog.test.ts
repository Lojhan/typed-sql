import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import {
  postgresCatalogCanCast,
  postgresCatalogCast,
  postgresCatalogOperatorRule,
  postgresCatalogRoutineRule,
  postgresCatalogTableRoutineRule,
  postgresCatalogTypeMapping,
} from "../src/catalog/index.js";
import { POSTGRES_CORE_CATALOG_FORMAT_VERSION, POSTGRES_SUPPORT_POLICY, postgresCoreCatalog } from "../src/index.js";

const execute = promisify(execFile);

await describe("PostgreSQL versioned core catalogs", async () => {
  await it("ships immutable deterministic catalogs for every stable and canary major", () => {
    strict.strictEqual(POSTGRES_CORE_CATALOG_FORMAT_VERSION, 1);
    for (const major of [...POSTGRES_SUPPORT_POLICY.stableMajors, POSTGRES_SUPPORT_POLICY.canary.major]) {
      const catalog = postgresCoreCatalog(major);
      strict.strictEqual(catalog?.major, major);
      strict.match(catalog?.revision ?? "", /^sha256:[a-f\d]{64}$/u);
      strict.ok(Object.isFrozen(catalog));
      strict.ok(Object.isFrozen(catalog?.types));
      strict.ok(Object.isFrozen(catalog?.operators[0]?.operators));
      strict.ok(Object.isFrozen(catalog?.routines[0]?.routines));
    }
    strict.strictEqual(postgresCoreCatalog(13), undefined);
    strict.strictEqual(postgresCoreCatalog(20), undefined);
  });

  await it("indexes the generated type, operator, and routine families", () => {
    strict.strictEqual(postgresCatalogTypeMapping("INTEGER"), "number");
    strict.strictEqual(postgresCatalogTypeMapping("numeric(20, 2)[]"), "numeric");
    strict.strictEqual(postgresCatalogTypeMapping("made_up"), undefined);
    strict.strictEqual(postgresCatalogCast("integer", "numeric")?.context, "implicit");
    strict.strictEqual(postgresCatalogCast("text", "varchar")?.context, "implicit");
    strict.strictEqual(postgresCatalogCast("jsonb", "integer")?.context, "explicit");
    strict.strictEqual(postgresCatalogCast("integer", "regclass")?.method, "binary");
    strict.strictEqual(postgresCatalogCanCast("numeric", "integer", "implicit"), false);
    strict.strictEqual(postgresCatalogCanCast("numeric", "integer", "assignment"), true);
    strict.strictEqual(postgresCatalogCanCast("varbit", "bit", "implicit"), true);
    strict.strictEqual(postgresCatalogCanCast("integer", "bytea", "explicit"), false);
    strict.strictEqual(
      postgresCatalogCanCast("integer", "bytea", "explicit", {
        formatVersion: 1,
        dialect: "postgres",
        version: "18.0",
        tables: {},
      }),
      true,
    );
    strict.strictEqual(postgresCatalogCanCast("integer", "money", "assignment"), true);
    strict.strictEqual(postgresCatalogOperatorRule("IS DISTINCT FROM"), "boolean");
    strict.strictEqual(postgresCatalogOperatorRule("->>"), "json-text");
    strict.strictEqual(postgresCatalogOperatorRule("&"), "bitwise");
    strict.strictEqual(postgresCatalogOperatorRule("@@"), "special");
    strict.strictEqual(postgresCatalogOperatorRule("!!"), "special");
    strict.strictEqual(postgresCatalogOperatorRule("<->"), "special");
    strict.strictEqual(postgresCatalogOperatorRule("||/"), "special");
    strict.strictEqual(postgresCatalogOperatorRule("<=>"), undefined);
    strict.strictEqual(postgresCatalogRoutineRule("count"), "count");
    strict.strictEqual(postgresCatalogRoutineRule("jsonb_agg"), "json-aggregate");
    strict.strictEqual(postgresCatalogRoutineRule("jsonb_path_exists"), "json-path-boolean");
    strict.strictEqual(postgresCatalogRoutineRule("jsonb_path_query_array_tz"), "json-path-json");
    strict.strictEqual(postgresCatalogRoutineRule("jsonb_path_query"), "json-path-set");
    strict.strictEqual(postgresCatalogRoutineRule("made_up"), undefined);
    strict.strictEqual(postgresCatalogTableRoutineRule("unnest"), "array-elements");
    strict.strictEqual(postgresCatalogTableRoutineRule("generate_series"), "first-argument");
    strict.strictEqual(postgresCatalogTableRoutineRule("jsonb_path_query"), "json-path-query");
    strict.strictEqual(postgresCatalogTableRoutineRule("made_up"), undefined);
  });

  await it("selects cast evidence and removals by PostgreSQL major", () => {
    const schema = (version: string) => ({ formatVersion: 1, dialect: "postgres", version, tables: {} }) as const;
    strict.strictEqual(postgresCoreCatalog(14)?.casts.length, 198);
    strict.strictEqual(postgresCoreCatalog(15)?.casts.length, 197);
    strict.strictEqual(postgresCoreCatalog(16)?.casts.length, 197);
    strict.strictEqual(postgresCoreCatalog(17)?.casts.length, 197);
    strict.strictEqual(postgresCoreCatalog(18)?.casts.length, 203);
    strict.strictEqual(postgresCoreCatalog(19)?.casts.length, 203);
    strict.strictEqual(postgresCatalogCast("path", "point", schema("14.24"))?.context, "explicit");
    strict.strictEqual(postgresCatalogCast("path", "point", schema("15.19")), undefined);
    strict.strictEqual(postgresCatalogCanCast("integer", "bytea", "explicit", schema("17.11")), false);
    strict.strictEqual(postgresCatalogCanCast("integer", "bytea", "explicit", schema("18.6")), true);
  });

  await it("regenerates without drift and leaves no parallel resolver catalogs", async () => {
    await execute(process.execPath, [
      new URL("../../../scripts/generate-postgres-catalog.mjs", import.meta.url).pathname,
      "--check",
    ]);
    const resolver = await readFile(new URL("../src/resolver.ts", import.meta.url), "utf8");
    const typePolicy = await readFile(new URL("../src/type-policy.ts", import.meta.url), "utf8");
    strict.ok(!resolver.includes("const booleanOperators"));
    strict.ok(!resolver.includes("const numericTypes"));
    strict.ok(!typePolicy.includes('["smallint", "int2", "integer"'));
  });
});
