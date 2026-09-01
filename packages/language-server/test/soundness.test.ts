import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type SourceSoundnessCase,
  sourceForDialect,
  sourceSoundnessCorpus,
} from "../../../test/soundness/source-corpus.js";
import { compileSource } from "../../compiler/src/index.js";
import type { DialectPlugin, SchemaSnapshot } from "../../core/src/index.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { type SqliteSchemaSnapshot, sqlite } from "../../sqlite/src/index.js";
import { TypedSqlLanguageService } from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const postgresDirectory = resolve(workspace, "e2e/postgres");
const mysqlDirectory = resolve(workspace, "e2e/mysql");
const postgresSchema = postgres().validateSnapshot(
  JSON.parse(await readFile(resolve(postgresDirectory, "generated/db/schema.json"), "utf8")) as unknown,
);
const mysqlSchema = mysql().validateSnapshot(
  JSON.parse(await readFile(resolve(mysqlDirectory, "generated/db/schema.json"), "utf8")) as unknown,
);

interface EditorFixture<Snapshot extends SchemaSnapshot, Policy> {
  readonly name: "postgres" | "mysql" | "sqlite";
  readonly directory: string;
  readonly schema: Snapshot;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly service: TypedSqlLanguageService;
}

function editorService(directory: string): TypedSqlLanguageService {
  return new TypedSqlLanguageService(workspace, {
    configPath: resolve(directory, "typed-sql.config.ts"),
    schemaPath: resolve(directory, "generated/db/schema.json"),
    projectFile: resolve(directory, "tsconfig.json"),
    nativePreview: false,
  });
}

async function verifyCase<Snapshot extends SchemaSnapshot, Policy>(
  fixture: EditorFixture<Snapshot, Policy>,
  testCase: SourceSoundnessCase,
  index: number,
): Promise<void> {
  const source = sourceForDialect(testCase, fixture.name);
  const document = TextDocument.create(
    pathToFileURL(resolve(fixture.directory, `.soundness-editor-${index}.ts`)).href,
    "typescript",
    1,
    source,
  );
  const compilation = compileSource({ source, schema: fixture.schema, dialect: fixture.dialect });
  const analysis = await fixture.service.analysis(document);
  strict.ok(analysis !== undefined);
  strict.strictEqual(analysis?.transformedSource, compilation.transformedSource);
  strict.deepStrictEqual(analysis?.diagnostics, compilation.diagnostics);

  const diagnostics = await fixture.service.diagnostics(document);
  strict.strictEqual(diagnostics.length, compilation.diagnostics.length);
  diagnostics.forEach((diagnostic, diagnosticIndex) => {
    const expected = compilation.diagnostics[diagnosticIndex]!;
    strict.strictEqual(diagnostic.code, expected.code);
    strict.strictEqual(document.offsetAt(diagnostic.range.start), expected.range.start);
    strict.strictEqual(document.offsetAt(diagnostic.range.end), expected.range.end);
  });

  if (testCase.expectation.kind === "exact" || testCase.expectation.kind === "structural") {
    const queryOffset = source.indexOf("sql`") + 1;
    const hover = await fixture.service.hover(document, document.positionAt(queryOffset));
    const text = JSON.stringify(hover?.contents ?? "");
    strict.ok(text.includes("Query<"), text);
    strict.ok(!text.includes(": any"), text);
  }
}

await describe("editor service soundness parity", async () => {
  const sqliteDirectory = await mkdtemp(join(tmpdir(), "typed-sql-editor-sqlite-"));
  const sqliteSchema = {
    formatVersion: 1,
    dialect: "sqlite",
    dialectVersion: "1.0.0",
    tables: {
      users: {
        schema: "main",
        name: "users",
        kind: "table",
        strict: true,
        withoutRowid: false,
        indexes: [],
        foreignKeys: [],
        columns: {
          id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
          email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
          status: { name: "status", databaseType: "TEXT", tsType: "string", nullable: false },
          deleted_at: { name: "deleted_at", databaseType: "TEXT", tsType: "string", nullable: true },
        },
      },
      projects: {
        schema: "main",
        name: "projects",
        kind: "table",
        strict: true,
        withoutRowid: false,
        indexes: [],
        foreignKeys: [],
        columns: {
          id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
          owner_id: { name: "owner_id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        },
      },
    },
  } as const satisfies SqliteSchemaSnapshot;
  const sqliteSchemaPath = join(sqliteDirectory, "schema.json");
  const sqliteConfigPath = join(sqliteDirectory, "typed-sql.config.mjs");
  const sqliteProjectPath = join(sqliteDirectory, "tsconfig.json");
  const sqliteModule = pathToFileURL(resolve(workspace, "packages/sqlite/dist/packages/sqlite/src/index.js")).href;
  await Promise.all([
    writeFile(sqliteSchemaPath, `${JSON.stringify(sqliteSchema, null, 2)}\n`),
    writeFile(
      sqliteConfigPath,
      `import { sqlite } from ${JSON.stringify(sqliteModule)};\nexport default { dialect: sqlite(), schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"] };\n`,
    ),
    writeFile(sqliteProjectPath, `${JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] })}\n`),
  ]);
  const postgresFixture = {
    name: "postgres" as const,
    directory: postgresDirectory,
    schema: postgresSchema,
    dialect: postgres(),
    service: editorService(postgresDirectory),
  };
  const mysqlFixture = {
    name: "mysql" as const,
    directory: mysqlDirectory,
    schema: mysqlSchema,
    dialect: mysql(),
    service: editorService(mysqlDirectory),
  };
  const sqliteFixture = {
    name: "sqlite" as const,
    directory: sqliteDirectory,
    schema: sqliteSchema,
    dialect: sqlite(),
    service: new TypedSqlLanguageService(sqliteDirectory, {
      configPath: sqliteConfigPath,
      schemaPath: sqliteSchemaPath,
      projectFile: sqliteProjectPath,
      nativePreview: false,
    }),
  };
  try {
    for (const [index, testCase] of sourceSoundnessCorpus.entries()) {
      await it(`postgres: ${testCase.id}`, () => verifyCase(postgresFixture, testCase, index));
      await it(`mysql: ${testCase.id}`, () => verifyCase(mysqlFixture, testCase, index));
      await it(`sqlite: ${testCase.id}`, () => verifyCase(sqliteFixture, testCase, index));
    }
  } finally {
    await Promise.all([postgresFixture.service.close(), mysqlFixture.service.close(), sqliteFixture.service.close()]);
    await rm(sqliteDirectory, { recursive: true, force: true });
  }
});
