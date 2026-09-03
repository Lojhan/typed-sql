import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type SyntheticSnapshot, synthetic } from "../../../examples/synthetic-grammar/src/index.js";
import { assertSourceCompilation } from "../../../test/soundness/assert-source-corpus.js";
import {
  type SourceSoundnessCase,
  sourceForDialect,
  sourceSoundnessCorpus,
} from "../../../test/soundness/source-corpus.js";
import {
  analyzeSource as analyzeCompilerSource,
  compileSource,
  SOURCE_ANALYSIS_FORMAT_VERSION,
  type SourceAnalysisResult,
} from "../../compiler/src/index.js";
import type { DialectPlugin, SchemaSnapshot } from "../../core/src/index.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
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
  readonly name: "postgres" | "mysql" | "sqlite" | "synthetic";
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
  const source = fixture.name === "synthetic" ? testCase.source : sourceForDialect(testCase, fixture.name);
  const document = TextDocument.create(
    pathToFileURL(resolve(fixture.directory, `.soundness-editor-${index}.ts`)).href,
    "typescript",
    1,
    source,
  );
  const compilation = compileSource({ source, schema: fixture.schema, dialect: fixture.dialect });
  if (fixture.name === "synthetic") assertSourceCompilation({ ...testCase, source }, compilation);
  const batch = analyzeCompilerSource(
    {
      formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION,
      source: { id: document.uri, text: source, version: document.version },
    },
    { schema: fixture.schema, dialect: fixture.dialect },
  );
  const analysis = await fixture.service.analysis(document);
  strict.ok(analysis !== undefined);
  assertSemanticParity(analysis, batch);
  strict.strictEqual(batch.transformedSource, compilation.transformedSource);
  strict.deepStrictEqual(batch.diagnostics, compilation.diagnostics);

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

function assertSemanticParity(editor: SourceAnalysisResult | undefined, batch: SourceAnalysisResult): void {
  if (editor === undefined) throw new Error("Expected editor analysis");
  strict.strictEqual(editor.formatVersion, batch.formatVersion);
  strict.strictEqual(editor.source, batch.source);
  strict.strictEqual(editor.transformedSource, batch.transformedSource);
  strict.deepStrictEqual(editor.insertions, batch.insertions);
  strict.deepStrictEqual(editor.queries, batch.queries);
  strict.deepStrictEqual(editor.diagnostics, batch.diagnostics);
  strict.deepStrictEqual(editor.identity.source, batch.identity.source);
  strict.deepStrictEqual(editor.identity.grammar, batch.identity.grammar);
  strict.deepStrictEqual(editor.identity.schema, batch.identity.schema);
  strict.strictEqual(editor.identity.typePolicyHash, batch.identity.typePolicyHash);
  strict.deepStrictEqual(editor.identity.compiler, batch.identity.compiler);
}

await describe("editor service soundness parity", async () => {
  const sqliteDirectory = await mkdtemp(join(tmpdir(), "typed-sql-editor-sqlite-"));
  const syntheticDirectory = await mkdtemp(join(tmpdir(), "typed-sql-editor-synthetic-"));
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
  const normalizedSqliteSchema = sqlite().validateSnapshot(await loadSchemaSnapshot(sqliteSchemaPath));
  const syntheticSchema = {
    formatVersion: 1,
    dialect: "synthetic",
    dialectVersion: "1.0.0",
    version: "1.0.0",
    server: { product: "synthetic", version: "1.0.0", versionKey: "1", features: [], settings: {} },
    tables: {
      widgets: {
        name: "widgets",
        columns: {
          value: { name: "value", databaseType: "scalar", tsType: "number", nullable: false },
          label: { name: "label", databaseType: "text", tsType: "string", nullable: true },
        },
      },
    },
  } as const satisfies SyntheticSnapshot;
  const syntheticSchemaPath = join(syntheticDirectory, "schema.json");
  const syntheticConfigPath = join(syntheticDirectory, "typed-sql.config.mjs");
  const syntheticProjectPath = join(syntheticDirectory, "tsconfig.json");
  const syntheticModule = pathToFileURL(
    resolve(workspace, "examples/synthetic-grammar/dist/examples/synthetic-grammar/src/index.js"),
  ).href;
  await Promise.all([
    writeFile(syntheticSchemaPath, `${JSON.stringify(syntheticSchema, null, 2)}\n`),
    writeFile(
      syntheticConfigPath,
      `import { synthetic } from ${JSON.stringify(syntheticModule)};\nexport default { dialect: synthetic(), schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"] };\n`,
    ),
    writeFile(syntheticProjectPath, `${JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] })}\n`),
  ]);
  const normalizedSyntheticSchema = synthetic().validateSnapshot(await loadSchemaSnapshot(syntheticSchemaPath));
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
    schema: normalizedSqliteSchema,
    dialect: sqlite(),
    service: new TypedSqlLanguageService(sqliteDirectory, {
      configPath: sqliteConfigPath,
      schemaPath: sqliteSchemaPath,
      projectFile: sqliteProjectPath,
      nativePreview: false,
    }),
  };
  const syntheticFixture = {
    name: "synthetic" as const,
    directory: syntheticDirectory,
    schema: normalizedSyntheticSchema,
    dialect: synthetic(),
    service: new TypedSqlLanguageService(syntheticDirectory, {
      configPath: syntheticConfigPath,
      schemaPath: syntheticSchemaPath,
      projectFile: syntheticProjectPath,
      nativePreview: false,
    }),
  };
  const syntheticCases = [
    {
      id: "third-party-row-and-ordered-parameter",
      source: [
        'import { sql } from "@typed-sql/example-synthetic-grammar";',
        "const value = 1;",
        "export const query = sql`SELECT value FROM widgets WHERE value = ${value}`;",
      ].join("\n"),
      expectation: {
        kind: "exact",
        rowType: '{ "value": number; }',
        parameterType: "readonly [number]",
      },
    },
    {
      id: "third-party-nullability",
      source: [
        'import { sql } from "@typed-sql/example-synthetic-grammar";',
        "export const query = sql`SELECT label FROM widgets`;",
      ].join("\n"),
      expectation: {
        kind: "exact",
        rowType: '{ "label": string | null; }',
        parameterType: "readonly []",
      },
    },
    {
      id: "third-party-fail-closed-diagnostic",
      source: [
        'import { sql } from "@typed-sql/example-synthetic-grammar";',
        "export const query = sql`UNSUPPORTED`;",
      ].join("\n"),
      expectation: { kind: "diagnostic", codes: ["SYN001"], sourceTarget: "UNSUPPORTED" },
    },
  ] as const satisfies readonly SourceSoundnessCase[];
  try {
    for (const [index, testCase] of sourceSoundnessCorpus.entries()) {
      await it(`postgres: ${testCase.id}`, () => verifyCase(postgresFixture, testCase, index));
      await it(`mysql: ${testCase.id}`, () => verifyCase(mysqlFixture, testCase, index));
      await it(`sqlite: ${testCase.id}`, () => verifyCase(sqliteFixture, testCase, index));
    }
    for (const [index, testCase] of syntheticCases.entries()) {
      await it(`synthetic: ${testCase.id}`, () => verifyCase(syntheticFixture, testCase, index));
    }
  } finally {
    await Promise.all([
      postgresFixture.service.close(),
      mysqlFixture.service.close(),
      sqliteFixture.service.close(),
      syntheticFixture.service.close(),
    ]);
    await Promise.all([
      rm(sqliteDirectory, { recursive: true, force: true }),
      rm(syntheticDirectory, { recursive: true, force: true }),
    ]);
  }
});
