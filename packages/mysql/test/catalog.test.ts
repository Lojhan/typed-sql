import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import {
  mySqlCatalogCanCoerce,
  mySqlCatalogCoercion,
  mySqlCatalogCollation,
  mySqlCatalogHasRoutineInAnotherSeries,
  mySqlCatalogOperator,
  mySqlCatalogRoutine,
  mySqlCatalogType,
  mySqlCoreCatalogForSchema,
  normalizeMySqlType,
} from "../src/catalog/index.js";
import { MYSQL_CORE_CATALOG_FORMAT_VERSION, MYSQL_SUPPORT_POLICY, mySqlCoreCatalog } from "../src/index.js";

const execute = promisify(execFile);
const schema = (version: string) => ({ formatVersion: 1, dialect: "mysql", version, tables: {} }) as const;

await describe("MySQL versioned core catalogs", async () => {
  await it("ships immutable deterministic catalogs for every stable and canary series", () => {
    strict.strictEqual(MYSQL_CORE_CATALOG_FORMAT_VERSION, 1);
    const series = [...MYSQL_SUPPORT_POLICY.stable.map((target) => target.series), MYSQL_SUPPORT_POLICY.canary.series];
    for (const target of series) {
      const catalog = mySqlCoreCatalog(target);
      strict.strictEqual(catalog?.series, target);
      strict.match(catalog?.revision ?? "", /^sha256:[a-f\d]{64}$/u);
      strict.ok(Object.isFrozen(catalog));
      strict.ok(Object.isFrozen(catalog?.types));
      strict.ok(Object.isFrozen(catalog?.operators[0]?.operators));
      strict.ok(Object.isFrozen(catalog?.routines[0]?.routines));
    }
    strict.strictEqual(mySqlCoreCatalog("8.0"), undefined);
    strict.strictEqual(mySqlCoreCatalog("10.0"), undefined);
  });

  await it("indexes types, coercions, operators, routines, and collations", () => {
    strict.strictEqual(normalizeMySqlType(" DOUBLE   PRECISION UNSIGNED "), "double");
    strict.strictEqual(normalizeMySqlType(`varchar${"(".repeat(10_000)}`), `varchar${"(".repeat(10_000)}`);
    strict.strictEqual(mySqlCatalogType("INTEGER")?.name, "int");
    strict.strictEqual(mySqlCatalogType("decimal(20, 4) unsigned")?.category, "numeric-decimal");
    strict.strictEqual(mySqlCatalogType("geometrycollection")?.name, "geometry");
    strict.strictEqual(mySqlCatalogType("made_up"), undefined);
    strict.strictEqual(mySqlCatalogCanCoerce("int", "bigint", "arithmetic"), true);
    strict.strictEqual(mySqlCatalogCanCoerce("integer", "int", "assignment"), true);
    strict.strictEqual(mySqlCatalogCanCoerce("varchar", "double", "arithmetic"), true);
    strict.strictEqual(mySqlCatalogCanCoerce("json", "bigint", "assignment"), false);
    strict.strictEqual(mySqlCatalogCoercion("integer", "bigint")?.safety, "lossless");
    strict.strictEqual(mySqlCatalogCoercion("made_up", "bigint"), undefined);
    strict.strictEqual(mySqlCatalogCoercion("int", "made_up"), undefined);
    strict.strictEqual(mySqlCatalogCanCoerce("made_up", "made_up", "explicit"), true);
    strict.strictEqual(mySqlCatalogOperator("<=>")?.result, "boolean");
    strict.strictEqual(mySqlCatalogOperator("->>")?.result, "json-text");
    strict.strictEqual(mySqlCatalogRoutine("coalesce")?.result, "coalesce");
    strict.strictEqual(mySqlCatalogRoutine("json_extract")?.result, "json");
    strict.strictEqual(mySqlCatalogCollation("UTF8MB4_BIN")?.characterSet, "utf8mb4");
    strict.strictEqual(mySqlCatalogCollation("utf8mb4_bin")?.binary, true);
  });

  await it("selects VECTOR type and routine evidence only for 9.7 and later", () => {
    strict.strictEqual(mySqlCatalogType("vector", schema("8.4.12")), undefined);
    strict.strictEqual(mySqlCatalogRoutine("vector_dim", schema("8.4.12")), undefined);
    strict.strictEqual(mySqlCatalogType("vector(128)", schema("9.7.3"))?.category, "vector");
    strict.strictEqual(mySqlCatalogRoutine("vector_dim", schema("9.7.3"))?.result, "integer");
    strict.strictEqual(mySqlCatalogRoutine("vector_dim", schema("26.7.1"))?.result, "integer");
    strict.strictEqual(mySqlCatalogHasRoutineInAnotherSeries("vector_dim", schema("8.4.12")), true);
    strict.strictEqual(mySqlCatalogHasRoutineInAnotherSeries("made_up", schema("8.4.12")), false);
  });

  await it("fails closed when explicit server evidence has no supported catalog", () => {
    const unsupported = schema("8.0.40");
    strict.strictEqual(mySqlCoreCatalogForSchema(undefined), undefined);
    strict.strictEqual(mySqlCoreCatalogForSchema(unsupported), undefined);
    strict.strictEqual(mySqlCatalogType("int", unsupported), undefined);
    strict.strictEqual(mySqlCatalogCoercion("int", "bigint", unsupported), undefined);
    strict.strictEqual(mySqlCatalogOperator("+", unsupported), undefined);
    strict.strictEqual(mySqlCatalogRoutine("count", unsupported), undefined);
    strict.strictEqual(mySqlCatalogCollation("utf8mb4_bin", unsupported), undefined);
  });

  await it("regenerates without catalog drift", async () => {
    await execute(process.execPath, [
      new URL("../../../scripts/generate-mysql-catalog.mjs", import.meta.url).pathname,
      "--check",
    ]);
  });
});
