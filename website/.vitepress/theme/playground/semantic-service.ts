import ts from "@typed-sql/browser-typescript";
import { parameterTypeLiteral } from "@typed-sql/core";
import { expandRepeatedFragments } from "../../../../packages/compiler/src/repeated-fragments.js";
import { extractStaticQueries } from "../../../../packages/compiler/src/scanner.js";
import { browserDialectRuntime } from "./dialect-browser-runtime.js";
import type { EditorCompletion, EditorRequest, EditorResponse } from "./editor-protocol.js";
import { analyzePlaygroundSource, type PlaygroundDialect, type PlaygroundQuery } from "./playground.js";
import { isPlaygroundGrammarModule } from "./schema-catalog.js";
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
        if (name === `@typed-sql/${activeDialect}/runtime`)
          return declarations[`/${activeDialect}/runtime.d.ts`]
            ? { resolvedFileName: `/${activeDialect}/runtime.d.ts`, extension: ts.Extension.Dts }
            : undefined;
        if (name === "@typed-sql/core") return { resolvedFileName: "/core/index.ts", extension: ts.Extension.Ts };
        if (name === `@typed-sql/${activeDialect}`)
          return { resolvedFileName: "/grammar.d.ts", extension: ts.Extension.Dts };
        if (isPlaygroundGrammarModule(name)) return undefined;
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
  let overlays = new Map<string, Insertion[]>();
  let latestQueries: readonly WorkspaceQuery[] = [];
  let currentFiles: WorkspaceFiles = {};
  const transformedPosition = (file: string, position: number) =>
    position +
    (overlays.get(file) ?? [])
      .filter((item) => item.position <= position)
      .reduce((sum, item) => sum + item.text.length, 0);
  const preferences: ts.UserPreferences = {
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
    importModuleSpecifierEnding: "auto",
    importModuleSpecifierPreference: "relative",
    quotePreference: "double",
  };
  const completionOptions = { ...preferences, includeCompletionsWithSnippetText: false };
  const allowedCompletion = (entry: { source?: string; data?: ts.CompletionEntryData }) =>
    (!entry.data?.fileName || entry.data.fileName.startsWith(userRoot)) &&
    (!entry.source ||
      entry.source.startsWith(userRoot) ||
      entry.source.startsWith(".") ||
      entry.source === `@typed-sql/${activeDialect}`);

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
      overlays = new Map<string, Insertion[]>();
      currentFiles = { ...files };
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
          const extracted = extractStaticQueries(source, browserDialectRuntime(dialect).placeholder, [
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
            if (original) {
              const runtime = browserDialectRuntime(dialect);
              const repeated = expandRepeatedFragments(source, original, runtime.placeholder);
              insertions.push({
                position: original.insertionPosition,
                text: repeated ? `.__typedRow<${query.rowType}>()` : `<${query.rowType}, ${query.parameterType}>`,
              });
              if (repeated) {
                const analysis = runtime.analyze(repeated.query.sql, sql.snapshot);
                for (const { query: fragment, parameterOffset } of repeated.fragments) {
                  if (insertions.some((item) => item.position === fragment.insertionPosition)) continue;
                  const parameters = analysis.parameters
                    .filter(
                      ({ index }) => index > parameterOffset && index <= parameterOffset + fragment.parameterCount,
                    )
                    .map((parameter) => ({ ...parameter, index: parameter.index - parameterOffset }));
                  insertions.push({
                    position: fragment.insertionPosition,
                    text: `<${parameterTypeLiteral(fragment.parameterCount, parameters)}>`,
                  });
                }
              }
            }
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
            isPlaygroundGrammarModule(node.text) &&
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
      const program = service.getProgram();
      const checker = program?.getTypeChecker();
      if (checker)
        for (let index = 0; index < queries.length; index++) {
          const query = queries[index]!;
          if (!query.file.endsWith(".ts")) continue;
          const source = program?.getSourceFile(`${userRoot}${query.file}`);
          if (!source) continue;
          const position = transformedPosition(query.file, query.sourceStart);
          const visit = (node: ts.Node) => {
            if (ts.isTaggedTemplateExpression(node) && node.getStart(source) === position) {
              const type = checker.getTypeAtLocation(node);
              if (type.symbol?.name !== "Query" || !(type.flags & ts.TypeFlags.Object)) return;
              const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
              if (arguments_.length !== 2) return;
              const parameterType = checker.typeToString(arguments_[1]!, node, ts.TypeFormatFlags.NoTruncation);
              queries[index] = { ...query, parameterType, contract: `Query<${query.rowType}, ${parameterType}>` };
              return;
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
      latestQueries = queries;
      return { queries, hovers, problems, version: ts.version };
    },
    interact(request: EditorRequest): EditorResponse {
      const { file, position } = request;
      if (
        !file.endsWith(".ts") ||
        currentFiles[file] === undefined ||
        position < 0 ||
        position > currentFiles[file]!.length
      )
        return undefined;
      const fileName = `${userRoot}${file}`;
      const transformed = transformedPosition(file, position);
      if (request.kind === "definition") {
        const definitions = service.getDefinitionAtPosition(fileName, transformed) ?? [];
        for (const definition of definitions) {
          if (definition.fileName.startsWith(userRoot)) {
            const target = definition.fileName.slice(userRoot.length);
            if (!(target in currentFiles)) continue;
            const insertions = overlays.get(target) ?? [];
            return {
              file: target,
              from: originalPosition(definition.textSpan.start, insertions),
              to: originalPosition(definition.textSpan.start + definition.textSpan.length, insertions),
            };
          }
          if (definition.fileName.startsWith("/__sql__/")) {
            const target = definition.fileName.slice("/__sql__/".length, -".d.ts".length);
            if (!(target in currentFiles)) continue;
            const query =
              latestQueries.find((item) => item.file === target && item.binding === definition.name) ??
              latestQueries.find((item) => item.file === target);
            return { file: target, from: query?.sourceStart ?? 0, to: query?.sourceEnd ?? 0 };
          }
        }
        return undefined;
      }
      if (request.kind === "completions") {
        const info = service.getCompletionsAtPosition(fileName, transformed, completionOptions);
        const entries = (info?.entries ?? []).filter(allowedCompletion).map(
          (entry): EditorCompletion => ({
            name: entry.name,
            kind: entry.kind,
            sortText: entry.sortText,
            ...(entry.source ? { source: entry.source } : {}),
            ...(entry.insertText ? { insertText: entry.insertText } : {}),
            ...(entry.data ? { data: entry.data } : {}),
            ...(entry.replacementSpan
              ? {
                  replacement: {
                    from: originalPosition(entry.replacementSpan.start, overlays.get(file) ?? []),
                    to: originalPosition(
                      entry.replacementSpan.start + entry.replacementSpan.length,
                      overlays.get(file) ?? [],
                    ),
                  },
                }
              : {}),
          }),
        );
        if (info?.isGlobalCompletion && !entries.some((entry) => entry.name === "sql" && !entry.source))
          entries.push({
            name: "sql",
            kind: "function",
            sortText: "16",
            source: `@typed-sql/${activeDialect}`,
            grammarImport: true,
          });
        return entries;
      }
      if (request.entry.grammarImport) {
        if (request.entry.name !== "sql" || request.entry.source !== `@typed-sql/${activeDialect}`) return undefined;
        const source = currentFiles[file]!;
        const from = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
        return {
          edits: [{ from, to: from, insert: `import { sql } from "@typed-sql/${activeDialect}";\n` }],
          detail: "Import sql from the selected grammar",
        };
      }
      if (!allowedCompletion(request.entry)) return undefined;
      // Background analysis rebuilds TypeScript's export map. Completion data
      // belongs to that map's generation, so resolve it again before acceptance.
      const freshEntry = service
        .getCompletionsAtPosition(fileName, transformed, completionOptions)
        ?.entries.find((entry) => entry.name === request.entry.name && entry.source === request.entry.source);
      if (!freshEntry) return undefined;
      const details = service.getCompletionEntryDetails(
        fileName,
        transformed,
        request.entry.name,
        { indentSize: 2, convertTabsToSpaces: true, newLineCharacter: "\n" },
        request.entry.source,
        preferences,
        freshEntry.data,
      );
      if (request.entry.source && !details?.codeActions?.length) return undefined;
      const edits = [];
      for (const action of details?.codeActions ?? []) {
        if (action.changes.some((change) => change.fileName !== fileName || change.isNewFile)) return undefined;
        for (const change of action.changes)
          for (const edit of change.textChanges) {
            const insertions = overlays.get(file) ?? [];
            const from = originalPosition(edit.span.start, insertions);
            const to = originalPosition(edit.span.start + edit.span.length, insertions);
            // Never apply a service edit that touches synthesized SQL type arguments.
            if (
              transformedPosition(file, from) !== edit.span.start ||
              transformedPosition(file, to) !== edit.span.start + edit.span.length
            )
              return undefined;
            let insert = edit.newText;
            const importSource = ts.createSourceFile("imports.ts", insert, ts.ScriptTarget.ES2022, true);
            const replacements: { from: number; to: number; text: string }[] = [];
            for (const statement of importSource.statements) {
              if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
              const specifier = statement.moduleSpecifier;
              if (!specifier.text.startsWith(".") || /\.(?:ts|sql)$/u.test(specifier.text)) continue;
              const path = relativePath(specifier.text, fileName);
              const suffix = virtual.has(`${path}.ts`) ? ".ts" : virtual.has(`${path}/index.ts`) ? "/index.ts" : "";
              if (suffix)
                replacements.push({
                  from: specifier.getStart(importSource) + 1,
                  to: specifier.end - 1,
                  text: specifier.text + suffix,
                });
            }
            for (const replacement of replacements.reverse())
              insert = insert.slice(0, replacement.from) + replacement.text + insert.slice(replacement.to);
            edits.push({ from, to, insert });
          }
      }
      return { edits, detail: ts.displayPartsToString(details?.displayParts) };
    },
    dispose: () => service.dispose(),
  };
}
