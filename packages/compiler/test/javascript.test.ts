import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { postgres } from "../../postgres/src/analysis.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import { analyzeSource, checkFile, compileSource, SOURCE_ANALYSIS_FORMAT_VERSION } from "../src/index.js";
import { javascriptProjection } from "../src/javascript.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/success"),
  schemaFile = join(fixtures, "schema.json"),
  dialect = postgres(),
  schema = dialect.validateSnapshot(await loadSchemaSnapshot(schemaFile));
const analysis = (source: string, id = "query.js", compiler = {}) =>
  analyzeSource(
    { formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION, source: { id, text: source }, compiler },
    { dialect, schema },
  );
async function native(source: string, extension = "js", checkJs = true) {
  const root = await mkdtemp(join(fixtures, ".javascript-check-")),
    file = join(root, `query.${extension}`),
    project = join(root, "tsconfig.json");
  try {
    await writeFile(file, source);
    await writeFile(
      project,
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { allowJs: true, checkJs, jsx: "react", jsxFactory: "h", ignoreDeprecations: "6.0" },
        files: [`query.${extension}`],
        include: [],
      }),
    );
    const result = await checkFile({ file, project, schema: schemaFile, dialect });
    strict.equal(await readFile(file, "utf8"), source);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
await describe("checked JavaScript SQL overlays", async () => {
  await it("retains native row and parameter inference without TypeScript syntax in JavaScript", async () => {
    const source =
      'import {sql} from "@typed-sql/postgres";export const query=sql`SELECT id,name FROM users WHERE id=${42}`;\n/** @type {import("@typed-sql/core").QueryRow<typeof query>} */ const row={id:1,name:"Ada"};\n/** @type {number} */ const id=row.id;\n/** @type {string} */ const name=row.name;';
    const valid = await native(source);
    strict.equal(valid.ok, true, valid.typeScript?.output);
    strict.equal(valid.analysis.queries[0]?.rowType, '{ "id": number; "name": string; }');
    strict.equal(valid.analysis.queries[0]?.parameterType, "readonly [number]");
    const invalid = await native(`${source}\n/** @type {string} */ const wrong=row.id;`);
    strict.equal(invalid.ok, false);
    strict.match(invalid.typeScript?.output ?? "", /TS2322/u);
    strict.ok(!valid.transformedSource.includes("ReturnType<"));
    strict.match(valid.transformedSource, /typeof sql\.__typed</u);
  });
  await it("checks original interpolation types and maps UTF-16 errors after all insertions", async () => {
    const source =
      'import {sql} from "@typed-sql/postgres";\nconst emoji="😀";\nconst wrong="text";\nexport const query=sql`SELECT id FROM users WHERE id=${wrong}`;';
    const result = await native(source);
    strict.equal(result.ok, false);
    strict.deepEqual(result.sqlDiagnostics, []);
    const line = source.split("\n")[3]!,
      column = line.indexOf("wrong") + 1;
    strict.match(result.typeScript?.output ?? "", new RegExp(`query\\.js\\(4,${column}\\): error TS2345`));
    strict.ok(!result.typeScript?.output.includes("TS1005"));
    const shadow = await native(`/** @template T @typedef {any} ReturnType */\n${source}`);
    strict.equal(shadow.ok, false);
    strict.match(shadow.typeScript?.output ?? "", /TS2345/u);
  });
  await it("supports JSX, fragments and repeated-fragment checked calls", async () => {
    const prefix = 'import {sql} from "@typed-sql/postgres";';
    const jsx = await native(
      prefix +
        "\nfunction h(tag,props,...children){return {tag,children};}\nexport const view=<box>ok</box>;export const query=sql`SELECT id FROM users WHERE id=${42}`;",
      "jsx",
      false,
    );
    strict.equal(jsx.ok, true, jsx.typeScript?.output);
    const fragment = await native(
      `${prefix}export const query=sql\`SELECT id FROM users WHERE 1=1 \${sql.fragment\`AND id=\${42}\`}\`;`,
    );
    strict.equal(
      fragment.ok,
      true,
      JSON.stringify({ sql: fragment.sqlDiagnostics, native: fragment.typeScript?.output }),
    );
    const invalid = await native(
      `${prefix}export const query=sql\`SELECT id FROM users WHERE 1=1 \${sql.fragment\`AND id=\${"wrong"}\`}\`;`,
    );
    strict.equal(invalid.ok, false);
    strict.match(invalid.typeScript?.output ?? "", /TS2345/u);
    const list = await native(
      prefix +
        "const ids=[1,2];export const query=sql`SELECT id FROM users WHERE id IN (${ids.map(id=>sql.fragment`${id}`)})`;",
    );
    strict.equal(list.ok, true, list.typeScript?.output);
    strict.match(list.transformedSource, /__typedRow/u);
    const invalidList = await native(
      prefix +
        'const ids=["wrong"];export const query=sql`SELECT id FROM users WHERE id IN (${ids.map(id=>sql.fragment`${id}`)})`;',
    );
    strict.equal(invalidList.ok, false);
    strict.match(invalidList.typeScript?.output ?? "", /TS2345/u);
  });
  await it("keeps comment delimiters in SQL-derived row properties inert and accurately typed", async () => {
    const source =
      'import {sql} from "@typed-sql/postgres";export const query=sql`SELECT id AS "a*/b" FROM users`;\n/** @type {import("@typed-sql/core").QueryRow<typeof query>} */ const row={"a*/b":1};\n/** @type {number} */ const id=row["a*/b"];';
    const valid = await native(source);
    strict.equal(valid.ok, true, valid.typeScript?.output);
    strict.ok(valid.transformedSource.includes("a*\\/b"));
    const invalid = await native(`${source}\n/** @type {string} */ const wrong=row["a*/b"];`);
    strict.equal(invalid.ok, false);
    strict.match(invalid.typeScript?.output ?? "", /TS2322/u);
  });
  await it("preserves TypeScript transforms and source spans while bounding JavaScript expansion", () => {
    const source = 'import {sql} from "@typed-sql/postgres";const query=sql`SELECT id FROM users WHERE id=${42}`;';
    const compiled = compileSource({ source, dialect, schema }),
      ts = analysis(source, "query.ts");
    strict.equal(ts.transformedSource, compiled.transformedSource);
    const js = analysis(source);
    strict.equal(js.queries[0]?.sourceRange.start, source.indexOf("sql`"));
    strict.equal(js.queries[0]?.sourceRange.end, source.lastIndexOf("`") + 1);
    strict.ok(
      js.insertions.every(
        (insertion, index) => index === 0 || insertion.position >= js.insertions[index - 1]!.position,
      ),
    );
    const budget = Buffer.byteLength(compiled.transformedSource) - Buffer.byteLength(source),
      limited = analysis(source, "query.js", { maxGeneratedDeclarationBytes: budget });
    strict.equal(limited.queries.length, 0);
    strict.equal(limited.transformedSource, source);
    strict.equal(limited.diagnostics.at(-1)?.code, "TSQ006");
    const badSql = analysis('import {sql} from "@typed-sql/postgres";const query=sql`SELECT missing FROM users`;');
    strict.ok(badSql.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    const dynamic = {
      ...compiled,
      queries: compiled.queries.map((query) => ({
        ...query,
        query: { ...query.query, insertionPosition: query.query.insertionPosition + 1 },
      })),
    };
    strict.equal(javascriptProjection(source, dynamic, 10000).diagnostics.at(-1)?.code, "TSQ005");
    const fragmentSource =
        'import {sql} from "@typed-sql/postgres";const query=sql`SELECT id FROM users WHERE 1=1 ${sql.fragment`AND id=${42}`}`;',
      withFragment = compileSource({ source: fragmentSource, dialect, schema });
    const invalidFragment = {
      ...withFragment,
      fragments: withFragment.fragments.map((fragment) => ({
        ...fragment,
        fragment: { ...fragment.fragment, insertionPosition: fragment.fragment.insertionPosition + 1 },
      })),
    };
    strict.equal(javascriptProjection(fragmentSource, invalidFragment, 10000).diagnostics.at(-1)?.code, "TSQ005");
  });
});
