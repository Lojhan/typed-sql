import { parameterTypeLiteral, rowTypeLiteral } from "@typed-sql/core";
import type { RoutineSnapshot, SchemaSnapshotV2 } from "../../../../packages/schema/src/model.js";
import { browserDialectRuntime } from "./dialect-browser-runtime.js";
import { type PlaygroundDialect, parsePlaygroundSchema } from "./playground.js";
import type { WorkspaceProblem, WorkspaceQuery } from "./semantic-service.js";
import type { WorkspaceFiles } from "./workspace.js";

export interface SqlStatement {
  readonly file: string;
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

const reservedNames = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof var void while with yield implements interface package private protected public".split(
    " ",
  ),
);

// Keep quoted strings, identifiers, dollar-quoted bodies and nested comments intact.
export function splitSql(source: string, file: string, delimiter = ";"): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  let comment = 0;
  let lineComment = false;
  const append = (end: number) => {
    const text = source.slice(start, end);
    if (text.trim()) statements.push({ file, text, from: start, to: end });
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (comment) {
      if (char === "/" && next === "*") {
        comment += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        comment -= 1;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (source.startsWith(quote, index)) {
        if (quote.length === 1 && next === quote) index += 1;
        else {
          index += quote.length - 1;
          quote = "";
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      comment = 1;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "$") {
      const tag = /^(?:\$[A-Za-z_][\w]*\$|\$\$)/u.exec(source.slice(index))?.[0];
      if (tag) {
        quote = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === delimiter && depth === 0) {
      append(index);
      start = index + 1;
    }
  }
  append(source.length);
  return statements;
}

function statementBody(text: string): string {
  return text.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/u, "");
}

function queryDirective(text: string): string | undefined {
  let remaining = text.trimStart();
  while (remaining.startsWith("--") || remaining.startsWith("/*")) {
    if (remaining.startsWith("--")) {
      const end = remaining.indexOf("\n");
      const comment = end < 0 ? remaining : remaining.slice(0, end);
      const name = /^--\s*name:\s*([A-Za-z_$][\w$]*)\s*$/u.exec(comment)?.[1];
      if (name) return name;
      remaining = end < 0 ? "" : remaining.slice(end + 1).trimStart();
    } else {
      let depth = 1;
      let cursor = 2;
      while (cursor < remaining.length && depth > 0) {
        if (remaining.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (remaining.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      if (depth !== 0) return undefined;
      remaining = remaining.slice(cursor).trimStart();
    }
  }
  return undefined;
}

export function workspaceProblem(
  files: WorkspaceFiles,
  file: string,
  from: number,
  to: number,
  code: string,
  message: string,
): WorkspaceProblem {
  return {
    file,
    from,
    to: Math.max(from + 1, to),
    line: files[file]!.slice(0, from).split("\n").length,
    code,
    message,
    severity: "error",
  };
}

export function analyzeSqlFiles(
  dialect: PlaygroundDialect,
  files: WorkspaceFiles,
): {
  snapshot?: SchemaSnapshotV2;
  queries: WorkspaceQuery[];
  modules: Record<string, string>;
  problems: WorkspaceProblem[];
} {
  const statements = Object.entries(files)
    .filter(([file]) => file.endsWith(".sql"))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([file, source]) => splitSql(source, file));
  const ddl: SqlStatement[] = [];
  const routines: SqlStatement[] = [];
  const queryStatements: SqlStatement[] = [];
  const problems: WorkspaceProblem[] = [];
  for (const statement of statements) {
    const body = statementBody(statement.text);
    if (!body.trim()) continue;
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/iu.test(body)) routines.push(statement);
    else if (/^(?:CREATE|ALTER|DROP|PRAGMA)\b/iu.test(body)) {
      ddl.push(statement);
    } else queryStatements.push(statement);
  }
  const segments: { statement: SqlStatement; start: number }[] = [];
  let schema = "";
  for (const statement of ddl) {
    segments.push({ statement, start: schema.length });
    schema += `${statement.text};\n`;
  }
  const parsed = parsePlaygroundSchema(dialect, schema, true);
  for (const diagnostic of parsed.diagnostics) {
    let offset =
      schema
        .split("\n")
        .slice(0, diagnostic.line - 1)
        .reduce((sum, line) => sum + line.length + 1, 0) +
      diagnostic.column -
      1;
    while (offset < schema.length && /\s/u.test(schema[offset]!)) offset += 1;
    const segment = [...segments].reverse().find(({ start }) => offset >= start);
    const file =
      segment?.statement.file ?? Object.keys(files).find((name) => name.endsWith(".sql")) ?? Object.keys(files)[0]!;
    const from = segment ? segment.statement.from + offset - segment.start : 0;
    problems.push(workspaceProblem(files, file, from, from + 1, diagnostic.code, diagnostic.message));
  }
  const snapshot = parsed.snapshot;
  const runtime = browserDialectRuntime(dialect);
  if (snapshot) {
    const registry: Record<string, RoutineSnapshot[]> = {};
    for (const statement of routines) {
      const body = statementBody(statement.text);
      const match =
        /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(([\s\S]*?)\)\s+RETURNS\s+([\s\S]+?)(?=\s+(?:LANGUAGE|AS|IMMUTABLE|STABLE|VOLATILE|STRICT|CALLED|RETURNS\s+NULL|DETERMINISTIC|NOT\s+DETERMINISTIC|NO\s+SQL|READS|CONTAINS|MODIFIES|RETURN)\b)([\s\S]+)$/iu.exec(
          body,
        );
      const unsupported = dialect === "sqlite" || !match || /^(?:TABLE|SETOF|TRIGGER|RECORD)\b/iu.test(match[3]!);
      if (unsupported) {
        problems.push(
          workspaceProblem(
            files,
            statement.file,
            statement.from,
            statement.to,
            "PLAY201",
            "This playground supports declared scalar CREATE FUNCTION signatures for PostgreSQL and MySQL. Function bodies are not executed; SQLite functions must be registered by an application.",
          ),
        );
        continue;
      }
      const nameParts = match[1]!.split(".");
      const name = nameParts.pop()!;
      const namespace = nameParts[0] ?? (dialect === "postgres" ? "public" : "app");
      const args = splitSql(match[2]!, statement.file, ",").map(({ text }) => {
        const argument = /^(?:(?:IN|INOUT)\s+)?(?:[A-Za-z_][\w]*\s+)?(.+?)\s*$/iu.exec(text.trim());
        const databaseType = argument?.[1]?.trim() ?? "unknown";
        return {
          mode: "in" as const,
          databaseType,
          typeIdentity: databaseType,
          tsType: runtime.mapType(databaseType, snapshot, true),
          default: "none" as const,
        };
      });
      const databaseType = match[3]!.trim();
      const tsType = runtime.mapType(databaseType, snapshot, true);
      const attributes = match[4]!;
      const quotedBody = /\bAS\s+(\$(?:[A-Za-z_][\w]*)?\$)[\s\S]*?\1|\bAS\s+'(?:''|[^'])*'/iu.test(attributes);
      if (
        args.some((arg) => arg.tsType === "unknown") ||
        tsType === "unknown" ||
        !(dialect === "postgres"
          ? /\bLANGUAGE\s+(?:SQL|PLPGSQL)\b/iu.test(attributes) && quotedBody
          : /\bRETURN\s+\S/iu.test(attributes))
      ) {
        problems.push(
          workspaceProblem(
            files,
            statement.file,
            statement.from,
            statement.to,
            "PLAY202",
            "Use a scalar function with named, supported argument types, a RETURNS type, and a SQL body. Its declared result remains nullable.",
          ),
        );
        continue;
      }
      const key = `${namespace}.${name}`;
      const routine: RoutineSnapshot = {
        name,
        schema: namespace,
        identity: `${key}(${args.map((arg) => arg.databaseType).join(",")})`,
        kind: "function",
        arguments: args,
        result: { kind: "scalar", typeIdentity: databaseType, databaseType, tsType, nullable: true },
        volatility: /\bIMMUTABLE\b/iu.test(attributes)
          ? "immutable"
          : /\bSTABLE\b/iu.test(attributes)
            ? "stable"
            : "unknown",
        deterministic: /\bNOT\s+DETERMINISTIC\b/iu.test(attributes)
          ? false
          : /\bDETERMINISTIC\b/iu.test(attributes)
            ? true
            : "unknown",
        dataAccess: "unknown",
        nullInput: /\bSTRICT\b|\bRETURNS\s+NULL\s+ON\s+NULL\s+INPUT\b/iu.test(attributes) ? "strict" : "unknown",
      };
      const overloads = registry[key] ?? [];
      if (overloads.some((item) => item.identity === routine.identity))
        problems.push(
          workspaceProblem(
            files,
            statement.file,
            statement.from,
            statement.to,
            "PLAY203",
            `Duplicate function signature ${routine.identity}.`,
          ),
        );
      else registry[key] = [...overloads, routine];
    }
    Object.assign(snapshot, { routines: registry });
  }
  const queries: WorkspaceQuery[] = [];
  const modules: Record<string, string> = {};
  const fatalSchema = problems.length > 0 || snapshot === undefined;
  const perFile = new Map<string, { name: string; declaration: string }[]>();
  const ambiguousFiles = new Set<string>();
  for (const statement of queryStatements) {
    const list = perFile.get(statement.file) ?? [];
    const basename = statement.file
      .split("/")
      .pop()!
      .replace(/\.sql$/u, "")
      .replace(/\W/gu, "_");
    const directive = queryDirective(statement.text);
    const name =
      directive ??
      `${reservedNames.has(basename) ? `query_${basename}` : basename}${list.length === 0 ? "" : list.length + 1}`;
    if (reservedNames.has(name)) {
      problems.push(
        workspaceProblem(
          files,
          statement.file,
          statement.from,
          statement.to,
          "PLAY205",
          `SQL query name ${name} is a reserved TypeScript keyword. Choose another -- name: identifier.`,
        ),
      );
      continue;
    }
    let rowType = "unknown";
    let parameterType = "readonly unknown[]";
    if (!fatalSchema && snapshot) {
      const analysis = runtime.analyze(statement.text, snapshot);
      for (const diagnostic of analysis.diagnostics) {
        const from = statement.from + diagnostic.range.start;
        const problem = workspaceProblem(
          files,
          statement.file,
          from,
          statement.from + diagnostic.range.end,
          diagnostic.code,
          diagnostic.message,
        );
        problems.push({ ...problem, severity: diagnostic.severity === "warning" ? "warning" : "error" });
      }
      if (!analysis.diagnostics.some(({ severity }) => severity === "error")) {
        const parameterCount = Math.max(0, ...analysis.parameters.map(({ index }) => index));
        if (parameterCount > 256) {
          problems.push(
            workspaceProblem(
              files,
              statement.file,
              statement.from,
              statement.to,
              "PLAY206",
              "SQL query files support up to 256 parameter positions.",
            ),
          );
          list.push({
            name,
            declaration: `export declare const ${name}: (...parameters: readonly unknown[]) => import("@typed-sql/core").Query<unknown>;`,
          });
          perFile.set(statement.file, list);
          continue;
        }
        rowType = analysis.resultKind === "command" ? "never" : rowTypeLiteral(analysis.columns);
        parameterType = parameterTypeLiteral(parameterCount, analysis.parameters);
        queries.push({
          file: statement.file,
          binding: name,
          rowType,
          parameterType,
          sourceStart: statement.from,
          sourceEnd: statement.to,
          sql: statement.text,
          contract: `Query<${rowType}, ${parameterType}>`,
        });
      }
    }
    if (list.some((item) => item.name === name)) {
      ambiguousFiles.add(statement.file);
      problems.push(
        workspaceProblem(
          files,
          statement.file,
          statement.from,
          statement.to,
          "PLAY204",
          `Duplicate SQL query name ${name}.`,
        ),
      );
    } else
      list.push({
        name,
        declaration: `export declare const ${name}: (...parameters: ${parameterType}) => import("@typed-sql/core").Query<${rowType}, ${parameterType}>;`,
      });
    perFile.set(statement.file, list);
  }
  for (const file of Object.keys(files).filter((name) => name.endsWith(".sql"))) {
    const exports = perFile.get(file) ?? [];
    modules[`/__sql__/${file}.d.ts`] = exports.length
      ? exports
          .map(({ name, declaration }) =>
            ambiguousFiles.has(file)
              ? `export declare const ${name}: (...parameters: readonly unknown[]) => import("@typed-sql/core").Query<unknown>;`
              : declaration,
          )
          .join("\n") + (exports.length === 1 ? `\nexport default ${exports[0]!.name};` : "")
      : "export {};";
  }
  return {
    ...(fatalSchema ? {} : { snapshot }),
    queries: fatalSchema ? [] : queries.filter(({ file }) => !ambiguousFiles.has(file)),
    modules,
    problems,
  };
}
