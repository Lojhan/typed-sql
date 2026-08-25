import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
import { type MySqlSchemaSnapshot, mysql } from "../../mysql/src/index.js";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { TypedSqlLanguageService } from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const postgresDirectory = resolve(workspace, "e2e/postgres");
const mysqlDirectory = resolve(workspace, "e2e/mysql");
const postgresSchema = JSON.parse(
  await readFile(resolve(postgresDirectory, "generated/db/schema.json"), "utf8"),
) as PostgresSchemaSnapshot;
const mysqlSchema = JSON.parse(
  await readFile(resolve(mysqlDirectory, "generated/db/schema.json"), "utf8"),
) as MySqlSchemaSnapshot;

interface EditorFixture<Snapshot extends SchemaSnapshot, Policy> {
  readonly name: "postgres" | "mysql";
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
  try {
    for (const [index, testCase] of sourceSoundnessCorpus.entries()) {
      await it(`postgres: ${testCase.id}`, () => verifyCase(postgresFixture, testCase, index));
      await it(`mysql: ${testCase.id}`, () => verifyCase(mysqlFixture, testCase, index));
    }
  } finally {
    await Promise.all([postgresFixture.service.close(), mysqlFixture.service.close()]);
  }
});
