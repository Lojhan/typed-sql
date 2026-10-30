import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { sqlite } from "../../sqlite/src/index.js";
import { compileSqlFile, DEFAULT_MAX_SOURCE_BYTES } from "../src/index.js";

const dialect = postgres();
const schema = dialect.validateSnapshot(
  JSON.parse(await readFile(new URL("../../../test/fixtures/success/schema.json", import.meta.url), "utf8")),
);

await describe("stable SQL module compiler", async () => {
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

  await it("fails closed for repeated, gapped or reordered SQL placeholders", () => {
    for (const source of ["SELECT $1 AS a, $1 AS b", "SELECT $2 AS a", "SELECT $2 AS a, $1 AS b"]) {
      const result = compileSqlFile({ dialect, schema, source });
      strict.ok(result.diagnostics.some((item) => item.code === 901));
      strict.match(result.text, /query: never/u);
      strict.match(result.runtime, /throw new SyntaxError/u);
    }
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
