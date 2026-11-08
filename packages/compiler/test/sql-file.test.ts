import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, it, strict } from "poku";
import { renderQuery } from "../../core/src/index.js";
import { mysql } from "../../mysql/src/analysis.js";
import { postgres } from "../../postgres/src/analysis.js";
import { postgresRenderer } from "../../postgres/src/runtime.js";
import { sqlite } from "../../sqlite/src/analysis.js";
import { compileSqlFile, DEFAULT_MAX_SOURCE_BYTES } from "../src/index.js";

const dialect = postgres();
const schema = dialect.validateSnapshot(
  JSON.parse(await readFile(new URL("../../../test/fixtures/success/schema.json", import.meta.url), "utf8")),
);

await describe("stable SQL module compiler", async () => {
  await it("tree-shakes unselected SQL modules through a barrel without application sideEffects metadata", async () => {
    const used = compileSqlFile({ dialect, schema, source: "SELECT $1::bigint AS retained" });
    const unused = compileSqlFile({ dialect, schema, source: "SELECT 'unused-query-marker' AS unused_column" });
    strict.deepEqual(used.diagnostics, []);
    strict.deepEqual(unused.diagnostics, []);
    const modules = new Map([
      ["used.js", used.runtime],
      ["unused.js", unused.runtime],
      ["barrel.js", 'export {default as used} from "./used.js"; export {default as unused} from "./unused.js";'],
    ]);
    const bundle = () =>
      build({
        stdin: { contents: 'export {used} from "./barrel.js";', loader: "js" },
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        minify: true,
        treeShaking: true,
        plugins: [
          {
            name: "generated-sql-modules",
            setup(bundler) {
              bundler.onResolve({ filter: /^\.\// }, (args) => ({ path: args.path.slice(2), namespace: "sql-module" }));
              bundler.onLoad({ filter: /.*/, namespace: "sql-module" }, (args) => ({
                contents: modules.get(args.path)!,
                loader: "js",
              }));
              bundler.onResolve({ filter: /^@typed-sql\// }, (args) => ({
                path: import.meta.resolve(args.path),
                external: true,
              }));
            },
          },
        ],
      });
    const code = (await bundle()).outputFiles[0]!.text;
    strict.ok(!code.includes("unused-query-marker"), "Unused SQL text must leave the bundle");
    strict.ok(!code.includes("unused_column"), "Unused value plans must leave the bundle");
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    strict.deepEqual(renderQuery(module.used(42n), postgresRenderer).values, [42n]);
    strict.match(renderQuery(module.used(42n), postgresRenderer).text, /AS retained/u);
    const runtime = await import(import.meta.resolve("@typed-sql/core"));
    strict.equal(runtime.getQueryValuePlan(module.used(42n)).columns[0].type, "bigint");
    const invalid = compileSqlFile({ dialect, schema, source: "SELECT missing FROM absent" });
    strict.ok(invalid.diagnostics.length > 0);
    modules.set("unused.js", invalid.runtime);
    const invalidBundle = (await bundle()).outputFiles[0]!.text;
    await strict.rejects(
      import(`data:text/javascript;base64,${Buffer.from(invalidBundle).toString("base64")}`),
      SyntaxError,
    );
  });
  await it("rejects invalid codec metadata before a generated initializer can be marked pure", () => {
    const invalid = {
      ...dialect,
      analyze(...args: Parameters<typeof dialect.analyze>) {
        const result = dialect.analyze(...args);
        return {
          ...result,
          columns: result.columns.map((column) => ({ ...column, runtimeType: "invalid-runtime-type" as never })),
        };
      },
    };
    strict.throws(() => compileSqlFile({ dialect: invalid, schema, source: "SELECT 1 AS value" }), /runtime|type/iu);
  });
  await it("retains grammar type dependencies when SQL becomes invalid while failing closed", () => {
    for (const grammar of [postgres(), mysql(), sqlite()]) {
      const snapshot = grammar.validateSnapshot({ dialect: grammar.id, tables: {} });
      const valid = compileSqlFile({ dialect: grammar, schema: snapshot, source: "SELECT 1 AS value" });
      const invalid = compileSqlFile({ dialect: grammar, schema: snapshot, source: "SELECT missing FROM absent" });
      strict.deepStrictEqual(valid.diagnostics, []);
      strict.ok(invalid.diagnostics.length > 0);
      strict.match(invalid.text, /declare const query: never/u);
      strict.match(invalid.text, /^import type \{\} from /u);
      strict.match(invalid.runtime, /throw new SyntaxError/u);
      // Type-only dependencies remain present in both compiler inputs, without
      // introducing a runtime driver import or a callable invalid query.
      for (const result of [valid, invalid]) {
        strict.ok(result.text.includes(`from ${JSON.stringify(grammar.runtimeSqlModule)}`));
        strict.match(result.text, /^import type /u);
      }
    }
  });

  await it("uses grammar-owned placeholder scanning and ordered parameter inference across grammars", () => {
    for (const grammar of [postgres(), mysql(), sqlite()]) {
      const snapshot = grammar.validateSnapshot({
        dialect: grammar.id,
        tables: {
          account: {
            name: "account",
            schema: "main",
            kind: "table",
            strict: true,
            columns: {
              email: {
                name: "email",
                databaseType: grammar.id === "sqlite" ? "TEXT" : "text",
                tsType: "string",
                nullable: false,
              },
            },
            indexes: [],
            foreignKeys: [],
          },
        },
      });
      const marker = grammar.id === "postgres" ? "$1" : "?";
      const result = compileSqlFile({
        dialect: grammar,
        schema: snapshot,
        source: `SELECT email FROM account WHERE email = ${marker}`,
      });
      strict.deepStrictEqual(result.diagnostics, []);
      strict.match(result.text, /readonly \[string\]/u);
      strict.match(result.text, /"email": string/u);
      strict.match(result.runtime, /defineQueryValuePlan/u);
      strict.match(result.runtime, /SQL file expects 1 positional parameters/u);
      strict.ok(!result.text.includes("any"));
    }
  });

  await it("supports repeated and reordered positional bindings while rejecting gaps", () => {
    for (const source of ["SELECT $1::bigint AS a, $1::bigint AS b", "SELECT $2::text AS a, $1::bigint AS b"]) {
      const result = compileSqlFile({ dialect, schema, source });
      strict.deepStrictEqual(result.diagnostics, []);
      strict.ok(result.query);
      strict.strictEqual(result.query!.variants[0]!.parameters.length, 2);
    }
    const result = compileSqlFile({ dialect, schema, source: "SELECT $2::bigint AS a" });
    strict.ok(result.diagnostics.some((item) => item.code === 901));
    strict.match(result.text, /query: never/u);
  });

  await it("binds repeated named parameters across grammars and ignores lexical lookalikes", () => {
    for (const grammar of [postgres(), mysql(), sqlite()]) {
      const snapshot = grammar.validateSnapshot({
        dialect: grammar.id,
        tables: {
          users: {
            name: "users",
            strict: true,
            columns: { name: { name: "name", databaseType: "text", tsType: "string", nullable: false } },
          },
        },
      });
      const source = "SELECT name, ':fake' AS label FROM users WHERE name = :name OR name = :name -- :ignored\n";
      const result = compileSqlFile({ dialect: grammar, schema: snapshot, source });
      strict.deepStrictEqual(result.diagnostics, []);
      strict.match(result.text, /parameters: \{ "name": string/u);
      strict.strictEqual(result.query?.variants[0]?.parameters.length, 2);
      strict.ok(result.query?.query.sql.includes(":fake"));
      strict.ok(result.query?.query.sql.includes(":ignored"));
      strict.match(result.runtime, /\[0,0\]\[index - 1\]/u);
      const mixed = compileSqlFile({
        dialect: grammar,
        schema: snapshot,
        source: `SELECT name FROM users WHERE name = :name OR name = ${grammar.placeholder(1)}`,
      });
      strict.ok(mixed.diagnostics.some((item) => item.messageText.includes("cannot mix")));
    }
    const incompatible = compileSqlFile({ dialect, schema, source: "SELECT :value::bigint AS a, :value::text AS b" });
    strict.ok(incompatible.diagnostics.some((item) => item.messageText.includes("incompatible inferred types")));
    const source = "SELECT '😀' AS emoji,\n :long_name::bigint AS id, missing FROM nowhere";
    const invalid = compileSqlFile({ dialect, schema, source });
    strict.ok(
      invalid.diagnostics.some((item) => source.slice(item.start, item.start + item.length).includes("nowhere")),
    );
  });

  await it("preserves PostgreSQL slice colons, dollar strings and casts when scanning names", () => {
    const source =
      "SELECT numbers[lower:upper], numbers[:upper], numbers[(:index)], ARRAY[:value], $$:ignored$$, :id::bigint FROM users";
    const parameters = dialect.parameterOccurrences!(source, schema);
    strict.deepStrictEqual(
      parameters.map((item) => item.name),
      ["index", "value", "id"],
    );
    strict.deepStrictEqual(
      parameters.map((item) => source.slice(item.range.start, item.range.end)),
      [":index", ":value", ":id"],
    );
  });

  await it("executes generated factories with reordered/repeated values and validates named arguments", async () => {
    const load = async (source: string) => {
      const result = compileSqlFile({ dialect, schema, source });
      strict.deepStrictEqual(result.diagnostics, []);
      const runtime = result.runtime.replaceAll(
        JSON.stringify(dialect.runtimeSqlModule),
        JSON.stringify(import.meta.resolve(dialect.runtimeSqlModule!)),
      );
      return (await import(`data:text/javascript;base64,${Buffer.from(runtime).toString("base64")}`)).default;
    };
    const positional = await load("SELECT $2::text AS a, $1::bigint AS b, $2::text AS c");
    const rendered = renderQuery(positional(42n, "Ada"), postgresRenderer);
    strict.deepStrictEqual(rendered.values, ["Ada", 42n, "Ada"]);
    strict.match(rendered.text, /\$1::text AS a, \$2::bigint AS b, \$3::text AS c/u);
    strict.throws(() => positional(42n), /expects 2/u);
    const named = await load("SELECT :id::bigint AS a, :id::bigint AS b");
    strict.deepStrictEqual(renderQuery(named({ id: 7n }), postgresRenderer).values, [7n, 7n]);
    strict.throws(() => named({}), /named parameters/u);
    strict.throws(() => named({ id: 1n, extra: true }), /named parameters/u);
    strict.throws(() => named(Object.create({ id: 1n })), /named parameters/u);
    strict.throws(() => named(null), /named parameters/u);
  });

  await it("keeps hostile SQL text and metadata as data in script-safe generated modules", async () => {
    const payload = '</script><script>globalThis.__typedSqlInjected = true</script>"`\\\n\u2028\u2029';
    const column = "value</script><script>globalThis.__typedSqlInjected = true</script>\u2028\u2029";
    const source = `SELECT '${payload}' AS "${column}", :id::bigint AS id`;
    const result = compileSqlFile({ dialect, schema, source });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.ok(!/[<\u2028\u2029]/u.test(result.runtime));
    strict.ok(result.runtime.includes("\\u003c/script\\u003e"));
    const runtime = result.runtime.replaceAll(
      JSON.stringify(dialect.runtimeSqlModule),
      JSON.stringify(import.meta.resolve(dialect.runtimeSqlModule!)),
    );
    strict.strictEqual(Reflect.has(globalThis, "__typedSqlInjected"), false);
    const module = await import(`data:text/javascript;base64,${Buffer.from(runtime).toString("base64")}`);
    const rendered = renderQuery(module.default({ id: 7n }), postgresRenderer);
    strict.strictEqual(rendered.text, source.replace(":id", "$1"));
    strict.deepStrictEqual(rendered.values, [7n]);
    strict.strictEqual(module.valuePlan.columns[0].name, column);
    strict.strictEqual(Reflect.has(globalThis, "__typedSqlInjected"), false);

    const invalid = compileSqlFile({
      dialect,
      schema,
      source: 'SELECT missing FROM "absent</script><script>injected</script>"',
    });
    strict.ok(invalid.diagnostics.length > 0);
    strict.ok(!/[<\u2028\u2029]/u.test(invalid.runtime));
    await strict.rejects(
      import(`data:text/javascript;base64,${Buffer.from(invalid.runtime).toString("base64")}`),
      (error: unknown) => error instanceof SyntaxError && error.message.includes("absent</script>"),
    );
  });

  await it("rejects inconsistent third-party grammar binding contracts and preserves source offsets", () => {
    const source = "SELECT $1 AS value";
    const placeholder = source.indexOf("$1");
    for (const occurrences of [
      [],
      [{ index: 1, range: { start: -1, end: 2, line: 1, column: 1 } }],
      [{ index: 1, range: { start: placeholder, end: source.length + 1, line: 1, column: 1 } }],
      [{ index: 1, range: { start: placeholder, end: placeholder, line: 1, column: 1 } }],
      [
        { index: 1, range: { start: placeholder, end: placeholder + 2, line: 1, column: placeholder + 1 } },
        { index: 2, range: { start: placeholder, end: placeholder + 2, line: 1, column: placeholder + 1 } },
      ],
    ]) {
      const result = compileSqlFile({
        dialect: { ...dialect, parameterOccurrences: () => occurrences },
        schema,
        source,
      });
      strict.ok(result.diagnostics.some((item) => item.code === 901));
      strict.match(result.text, /query: never/u);
    }
    const invalid = "SELECT '😀' AS emoji,\n missing FROM nowhere";
    const result = compileSqlFile({ dialect, schema, source: invalid });
    strict.ok(
      result.diagnostics.some((item) => invalid.slice(item.start, item.start + item.length).includes("nowhere")),
    );
    const noRuntime = { ...dialect };
    delete noRuntime.runtimeSqlModule;
    const noBinding = { ...dialect };
    delete noBinding.parameterOccurrences;
    for (const unsupported of [noRuntime, noBinding]) {
      strict.ok(compileSqlFile({ dialect: unsupported, schema, source }).diagnostics.some((item) => item.code === 901));
    }
  });

  await it("bounds input and generated declarations and preserves command result semantics", () => {
    strict.ok(
      compileSqlFile({ dialect, schema, source: " ".repeat(DEFAULT_MAX_SOURCE_BYTES + 1) }).diagnostics.some(
        (item) => item.code === 901,
      ),
    );
    const oversized = {
      ...dialect,
      analyze: (...args: Parameters<typeof dialect.analyze>) => ({
        ...dialect.analyze(...args),
        columns: [
          {
            name: "large",
            tsType: `"${"x".repeat(9 * 1024 * 1024)}"`,
            nullable: false,
            range: { start: 0, end: 1, line: 1, column: 1 },
          },
        ],
      }),
    };
    const result = compileSqlFile({ dialect: oversized, schema, source: "SELECT 1 AS value" });
    strict.match(result.runtime, /generated output exceeds/u);
    strict.match(result.text, /query: never/u);
    const command = compileSqlFile({ dialect, schema, source: "UPDATE users SET name = 'Ada'" });
    strict.deepStrictEqual(command.diagnostics, []);
    strict.match(command.text, /Query<never, readonly \[\]>/u);
  });
});
