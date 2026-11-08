import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compileSqlFile, SQL_FILE_DECLARATION_HEADER as header } from "@typed-sql/compiler";
import { BuildError, BuildSession } from "./engine.js";
import { type BuildOptions, prepareBuildSource } from "./project.js";

const normalized = (text: string) => text.replaceAll("\r\n", "\n");
const owned = (text: string) => normalized(text).startsWith(header);
const ignored = new Set(["node_modules", ".git", ".next", "dist", "coverage", ".turbo"]);

/** Co-located arbitrary-extension declarations; SQL and schema remain authoritative inputs. */
export async function generateSqlTypes(
  options: BuildOptions & { readonly check?: boolean } = {},
): Promise<{ readonly files: readonly string[]; readonly removed: readonly string[] }> {
  const session = new BuildSession(options);
  let project = await session.project();
  const sources: string[] = [];
  const declarations: string[] = [];
  let visited = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 100_000)
        throw new RangeError("SQL declaration discovery exceeds 100000 entries; scope cwd to a smaller project");
      const file = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(file);
      else if (entry.isFile() && file.endsWith(".sql") && session.accepts(file)) sources.push(file);
      else if (entry.isFile() && file.endsWith(".d.sql.ts") && session.accepts(file.replace(/\.d\.sql\.ts$/u, ".sql")))
        declarations.push(file);
    }
  };
  await visit(session.cwd);
  sources.sort();
  declarations.sort();
  const expected = new Map<string, string>();
  const diagnostics: import("./engine.js").BuildDiagnostic[] = [];
  const guards = new Set<() => Promise<void>>();
  for (const file of sources) {
    const source = await readFile(file, "utf8");
    const prepared = await prepareBuildSource(project, source, file, { deferInputChecks: true });
    if (prepared.assertCurrent) guards.add(prepared.assertCurrent);
    project = prepared.project;
    const { typePolicy } = prepared.project.loaded.config;
    const dialect = prepared.dialect;
    const result = compileSqlFile({
      source,
      dialect,
      schema: project.snapshot,
      ...(typePolicy === undefined ? {} : { typePolicy }),
    });
    const output = file.replace(/\.sql$/u, ".d.sql.ts");
    if (result.diagnostics.length > 0) {
      diagnostics.push(
        ...result.diagnostics.map((item) => {
          const prefix = source.slice(0, item.start);
          return {
            file,
            code: `TSQ${item.code}`,
            message: item.messageText.replace(/^TSQ\d+:\s*/u, ""),
            line: prefix.split("\n").length,
            column: prefix.length - prefix.lastIndexOf("\n"),
          };
        }),
      );
    } else {
      expected.set(output, `${header}${result.text}`);
    }
  }
  const assertCurrent = async () => {
    for (const guard of guards) await guard();
  };
  await assertCurrent();
  const removed: string[] = [];
  for (const file of declarations) {
    if (expected.has(file)) continue;
    const contents = await readFile(file, "utf8");
    if (!owned(contents)) continue;
    if (options.check)
      diagnostics.push({
        file,
        code: "TSQ_BUILD_TYPES_STALE",
        message: "Generated SQL declaration has no valid current source; run typed-sql-build types",
        line: 1,
        column: 1,
      });
    else {
      await rm(file);
      removed.push(file);
    }
  }
  for (const [file, contents] of expected) {
    let current: string | undefined;
    try {
      current = await readFile(file, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (current !== undefined && normalized(current) === normalized(contents)) continue;
    if (options.check)
      diagnostics.push({
        file,
        code: "TSQ_BUILD_TYPES_STALE",
        message: "SQL declarations do not match source/config/schema; run typed-sql-build types",
        line: 1,
        column: 1,
      });
    else {
      if (current !== undefined && !owned(current))
        throw new Error(`Refusing to overwrite application-owned declaration ${file}`);
      const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, contents, { flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  await assertCurrent();
  if (diagnostics.length > 0) throw new BuildError(diagnostics);
  return { files: [...expected.keys()], removed };
}
