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
    strict.strictEqual(postgresCatalogCanCast("numeric", "integer", "implicit"), false);
    strict.strictEqual(postgresCatalogCanCast("numeric", "integer", "assignment"), true);
    strict.strictEqual(postgresCatalogOperatorRule("IS DISTINCT FROM"), "boolean");
    strict.strictEqual(postgresCatalogOperatorRule("->>"), "json-text");
    strict.strictEqual(postgresCatalogOperatorRule("!!"), undefined);
    strict.strictEqual(postgresCatalogRoutineRule("count"), "count");
    strict.strictEqual(postgresCatalogRoutineRule("jsonb_agg"), "json-aggregate");
    strict.strictEqual(postgresCatalogRoutineRule("made_up"), undefined);
    strict.strictEqual(postgresCatalogTableRoutineRule("unnest"), "array-elements");
    strict.strictEqual(postgresCatalogTableRoutineRule("generate_series"), "first-argument");
    strict.strictEqual(postgresCatalogTableRoutineRule("made_up"), undefined);
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
