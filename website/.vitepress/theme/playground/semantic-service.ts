import ts from "@typed-sql/browser-typescript";
import { extractStaticQueries } from "../../../../packages/compiler/src/scanner.js";
import { analyzePlaygroundSource, type PlaygroundDialect, type PlaygroundQuery } from "./playground.js";
import { validWorkspaceFiles, type WorkspaceFile, type WorkspaceFiles } from "./workspace.js";
import { analyzeSqlFiles, workspaceProblem } from "./workspace-sql.js";
import { BROWSER_COMPILER_SETTINGS } from "./workspace-ui.js";

export interface WorkspaceHover {
  readonly from: number;
  readonly to: number;
  readonly content: string;
}

export interface WorkspaceProblem {
  readonly file: WorkspaceFile;
  readonly from: number;
  readonly to: number;
  readonly line: number;
  readonly message: string;
  readonly code: string;
  readonly severity: "error" | "warning";
}

export interface WorkspaceQuery extends PlaygroundQuery {
  readonly file: string;
}

export interface WorkspaceAnalysis {
  readonly queries: readonly WorkspaceQuery[];
  readonly hovers: Record<string, WorkspaceHover[]>;
  readonly problems: readonly WorkspaceProblem[];
  readonly version: string;
}

interface Insertion {
  readonly position: number;
  readonly text: string;
}

const userRoot = "/workspace/";

function relativePath(specifier: string, containing: string): string | undefined {
  const parts = containing.split("/").slice(0, -1).filter(Boolean);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function originalPosition(position: number, insertions: readonly Insertion[]): number {
  let shift = 0;
  for (const item of insertions) {
    if (position < item.position + shift) break;
    if (position <= item.position + shift + item.text.length) return item.position;
    shift += item.text.length;
  }
  return position - shift;
}

export function createSemanticWorkspace(declarations: Readonly<Record<string, string>>) {
  let generation = 0;
  let virtual = new Map<string, string>();
  let scriptNames: string[] = [];
  let activeDialect: PlaygroundDialect = "postgres";
  const options: ts.CompilerOptions = {
    ...BROWSER_COMPILER_SETTINGS,
    target: ts.ScriptTarget[BROWSER_COMPILER_SETTINGS.target],
    module: ts.ModuleKind[BROWSER_COMPILER_SETTINGS.module],
    moduleResolution: ts.ModuleResolutionKind[BROWSER_COMPILER_SETTINGS.moduleResolution],
    moduleDetection: ts.ModuleDetectionKind[BROWSER_COMPILER_SETTINGS.moduleDetection],
    lib: [...BROWSER_COMPILER_SETTINGS.lib],
  };
  const read = (name: string) => virtual.get(name) ?? declarations[name];
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => scriptNames,
    getScriptVersion: () => String(generation),
    getProjectVersion: () => String(generation),
    getScriptSnapshot: (name) => {
      const source = read(name);
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
    },
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/lib/lib.es2022.d.ts",
    fileExists: (name) => read(name) !== undefined,
    readFile: read,
    readDirectory: () => [],
    useCaseSensitiveFileNames: () => true,
    directoryExists: (name) =>
      name === "/" || [...virtual.keys(), ...Object.keys(declarations)].some((file) => file.startsWith(`${name}/`)),
    resolveModuleNames: (names, containingFile) =>
      names.map((name) => {
        if (name === "@typed-sql/core") return { resolvedFileName: "/core/index.ts", extension: ts.Extension.Ts };
        if (name === `@typed-sql/${activeDialect}`)
          return { resolvedFileName: "/grammar.d.ts", extension: ts.Extension.Dts };
        if (/^@typed-sql\/(postgres|mysql|sqlite)$/u.test(name)) return undefined;
        if (containingFile.startsWith(userRoot) && name.startsWith(".")) {
          const path = relativePath(name, containingFile);
          if (path === undefined || !path.startsWith(userRoot)) return undefined;
        }
        if (name.startsWith(".") && name.endsWith(".sql")) {
          const path = relativePath(name, containingFile);
          const resolvedFileName = path?.startsWith(userRoot) ? `/__sql__/${path.slice(userRoot.length)}.d.ts` : "";
          return virtual.has(resolvedFileName) ? { resolvedFileName, extension: ts.Extension.Dts } : undefined;
        }
        return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
      }),
  };
  const service = ts.createLanguageService(host);

  return {
    analyze(dialect: PlaygroundDialect, files: WorkspaceFiles): WorkspaceAnalysis {
      if (!validWorkspaceFiles(files))
        throw new Error("Use up to 40 .ts/.sql files, 40,000 characters each, and 200,000 characters total.");
      generation += 1;
      activeDialect = dialect;
      const sql = analyzeSqlFiles(dialect, files);
      const problems: WorkspaceProblem[] = [...sql.problems];
      const queries: WorkspaceQuery[] = [...sql.queries];
      const hovers: Record<string, WorkspaceHover[]> = Object.fromEntries(Object.keys(files).map((file) => [file, []]));
      const overlays = new Map<string, Insertion[]>();
      virtual = new Map(Object.entries(sql.modules));
      const typescriptFiles = Object.keys(files)
        .filter((file) => file.endsWith(".ts"))
        .sort();
      scriptNames = [...typescriptFiles.map((file) => `${userRoot}${file}`), ...virtual.keys()];
      for (const file of typescriptFiles) {
        const source = files[file]!;
        const insertions: Insertion[] = [];
        if (sql.snapshot) {
          const result = analyzePlaygroundSource(dialect, sql.snapshot, source);
          const extracted = extractStaticQueries(source, (index) => (dialect === "postgres" ? `$${index}` : "?"), [
            `@typed-sql/${dialect}`,
          ]);
          for (const diagnostic of result.diagnostics) {
            // Regular TS modules need no SQL template.
            if (diagnostic.code === "PLAY103") continue;
            const from =
              source
                .split("\n")
                .slice(0, diagnostic.line - 1)
                .reduce((sum, line) => sum + line.length + 1, 0) +
              diagnostic.column -
              1;
            problems.push({
              ...workspaceProblem(files, file, from, from + 1, diagnostic.code, diagnostic.message),
              severity: diagnostic.severity,
            });
          }
          for (const query of result.queries) {
            queries.push({ ...query, file });
            const original = extracted.find((item) => item.range.start === query.sourceStart);
            if (original)
              insertions.push({
                position: original.insertionPosition,
                text: `<${query.rowType}, ${query.parameterType}>`,
              });
          }
        }
        insertions.sort((left, right) => left.position - right.position);
        overlays.set(file, insertions);
        let transformed = source;
        for (const insertion of [...insertions].reverse())
          transformed =
            transformed.slice(0, insertion.position) + insertion.text + transformed.slice(insertion.position);
        virtual.set(`${userRoot}${file}`, transformed);
      }
      for (const file of typescriptFiles) {
        const fileName = `${userRoot}${file}`;
        const sourceText = files[file]!;
        const insertions = overlays.get(file)!;
        const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
        const mismatchedImports: { from: number; to: number; module: string }[] = [];
        const findMismatchedImports = (node: ts.Node) => {
          if (
            ts.isStringLiteral(node) &&
            /^@typed-sql\/(postgres|mysql|sqlite)$/u.test(node.text) &&
            node.text !== `@typed-sql/${dialect}`
          ) {
            const parent = node.parent;
            const isModule =
              ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) ||
              (ts.isExternalModuleReference(parent) && parent.expression === node) ||
              (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
              (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent));
            if (isModule) mismatchedImports.push({ from: node.getStart(source), to: node.end, module: node.text });
          }
          ts.forEachChild(node, findMismatchedImports);
        };
        findMismatchedImports(source);
        for (const item of mismatchedImports)
          problems.push(
            workspaceProblem(
              files,
              file,
              item.from,
              item.to,
              "PLAY301",
              `${item.module} does not match the selected ${dialect} grammar. Import from "@typed-sql/${dialect}" or select the matching database.`,
            ),
          );
        for (const diagnostic of [
          ...service.getSyntacticDiagnostics(fileName),
          ...service.getSemanticDiagnostics(fileName),
        ]) {
          const from = originalPosition(diagnostic.start ?? 0, insertions);
          const to = originalPosition((diagnostic.start ?? 0) + (diagnostic.length ?? 1), insertions);
          if (diagnostic.code === 2307 && mismatchedImports.some((item) => from >= item.from && from < item.to))
            continue;
          problems.push({
            ...workspaceProblem(
              files,
              file,
              from,
              to,
              `TS${diagnostic.code}`,
              ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            ),
            severity: diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
          });
        }
        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
            const from = node.getStart(source);
            const transformed =
              from +
              insertions.filter((item) => item.position <= from).reduce((sum, item) => sum + item.text.length, 0);
            const info = service.getQuickInfoAtPosition(fileName, transformed);
            if (info)
              hovers[file]!.push({
                from,
                to: node.end,
                content:
                  ts.displayPartsToString(info.displayParts) +
                  (info.documentation?.length ? `\n\n${ts.displayPartsToString(info.documentation)}` : ""),
              });
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      for (const query of queries)
        hovers[query.file]!.push({
          from: query.sourceStart,
          to: query.sourceEnd,
          content: `Query<${query.rowType}, ${query.parameterType}>`,
        });
      return { queries, hovers, problems, version: ts.version };
    },
    dispose: () => service.dispose(),
  };
}
