import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import { DEFAULT_MAX_PARSE_DEPTH, DEFAULT_MAX_SQL_LENGTH, DEFAULT_MAX_TOKENS } from "../../packages/ast/src/index.js";
import {
  DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_STRUCTURAL_VARIANTS,
} from "../../packages/compiler/src/index.js";
import { CONFIG_CACHE_LIMIT } from "../../packages/config/src/index.js";
import { createFailureInjector, INJECTED_FAILURE_CODE } from "../../packages/conformance/src/index.js";
import {
  assessArtifactCompatibility,
  createDatabase,
  DEFAULT_MAX_FRAGMENT_LIST_ITEMS,
  DEFAULT_MAX_QUERY_PARAMETERS,
  DEFAULT_MAX_RENDERED_SQL_BYTES,
  type SqlRenderer,
  sql,
} from "../../packages/core/src/index.js";
import {
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_MAX_SCHEMA_CACHE_ENTRIES,
  DEFAULT_MAX_WORKSPACE_FILES,
} from "../../packages/language-server/src/index.js";
import {
  SqlParseError as MySqlParseError,
  parseStatement as parseMySql,
} from "../../packages/mysql/src/parser/index.js";
import {
  SqlParseError as PostgresParseError,
  parseStatement as parsePostgres,
} from "../../packages/postgres/src/parser/index.js";
import { parseSchemaSnapshot } from "../../packages/schema/src/index.js";
import {
  parseStatement as parseSqlite,
  SqlParseError as SqliteParseError,
} from "../../packages/sqlite/src/parser/index.js";

const workspace = resolve(import.meta.dirname, "../..");
const limits = JSON.parse(await readFile(join(workspace, "reliability-limits.json"), "utf8")) as {
  readonly formatVersion: number;
  readonly limits: Readonly<
    Record<string, { readonly value: number; readonly outcome: string; readonly owner: string }>
  >;
};

await describe("cross-component failures and resource bounds", async () => {
  await it("keeps the reviewed limit inventory synchronized with component defaults", () => {
    strict.strictEqual(limits.formatVersion, 1);
    strict.deepStrictEqual(
      Object.fromEntries(Object.entries(limits.limits).map(([name, value]) => [name, value.value])),
      {
        "ast.sourceBytes": DEFAULT_MAX_SQL_LENGTH,
        "ast.tokens": DEFAULT_MAX_TOKENS,
        "ast.parseDepth": DEFAULT_MAX_PARSE_DEPTH,
        "compiler.sourceBytes": DEFAULT_MAX_SOURCE_BYTES,
        "compiler.queries": DEFAULT_MAX_QUERIES,
        "compiler.structuralVariants": DEFAULT_MAX_STRUCTURAL_VARIANTS,
        "compiler.generatedDeclarationBytes": DEFAULT_MAX_GENERATED_DECLARATION_BYTES,
        "core.fragmentListItems": DEFAULT_MAX_FRAGMENT_LIST_ITEMS,
        "core.queryParameters": DEFAULT_MAX_QUERY_PARAMETERS,
        "core.renderedSqlBytes": DEFAULT_MAX_RENDERED_SQL_BYTES,
        "config.cacheEntries": CONFIG_CACHE_LIMIT,
        "languageServer.analysisCacheEntries": DEFAULT_MAX_CACHE_ENTRIES,
        "languageServer.schemaCacheEntries": DEFAULT_MAX_SCHEMA_CACHE_ENTRIES,
        "languageServer.workspaceFiles": DEFAULT_MAX_WORKSPACE_FILES,
      },
    );
    for (const limit of Object.values(limits.limits)) {
      strict.ok(
        Number.isSafeInteger(limit.value) && limit.value > 0 && limit.outcome.length > 0 && limit.owner.length > 0,
      );
    }
  });

  await it("bounds every owned parser with the same stable resource diagnostic", () => {
    for (const [parse, ErrorType] of [
      [parsePostgres, PostgresParseError],
      [parseMySql, MySqlParseError],
      [parseSqlite, SqliteParseError],
    ] as const) {
      strict.throws(
        () => parse("SELECT 1", { maxSqlLength: 1 }),
        (error: unknown) => error instanceof ErrorType && error.code === "TSQ002",
      );
      strict.throws(
        () => parse(`SELECT ${"(".repeat(12)}1${")".repeat(12)}`, { maxDepth: 4 }),
        (error: unknown) => error instanceof ErrorType && error.code === "TSQ002",
      );
    }
  });

  await it("propagates an injected database outage without publishing rows", async () => {
    const injector = createFailureInjector([{ point: "driver.execute", message: "database unavailable" }]);
    const renderer: SqlRenderer = { placeholder: (index) => `$${index}`, quoteIdentifier: (name) => name };
    const database = createDatabase(
      { execute: async () => injector.run("driver.execute", () => [{ optimistic: true }]) },
      renderer,
    );
    await strict.rejects(
      database.all(sql`SELECT ${1}`),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === INJECTED_FAILURE_CODE &&
        error.message === "database unavailable",
    );
  });

  await it("fails closed for corrupt and newer serialized state", () => {
    strict.throws(() => parseSchemaSnapshot({ formatVersion: 3, dialect: "synthetic", tables: {} }), /formatVersion/u);
    const reference = {
      formatVersion: 1,
      artifact: { kind: "query", version: "1" },
      producer: { core: "typed-sql-core-v1" },
      grammar: { id: "synthetic", version: "1", capabilityFingerprint: "sha256:a" },
      schema: { formatVersion: 2, hash: "sha256:b" },
      typePolicyHash: "sha256:c",
    } as const;
    strict.strictEqual(
      assessArtifactCompatibility(reference, { ...reference, futureRequired: true }).outcome,
      "corrupt-artifact",
    );
  });
});
