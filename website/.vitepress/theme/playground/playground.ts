import { parameterTypeLiteral, rowTypeLiteral, type SourceRange } from "@typed-sql/core";
import { expandRepeatedFragments } from "../../../../packages/compiler/src/repeated-fragments.js";
import { extractDynamicQueries, extractStaticQueries, mapSqlRange } from "../../../../packages/compiler/src/scanner.js";
import type {
  RelationSnapshot,
  SchemaSnapshotV2,
  TableSnapshot,
  TypeSnapshot,
} from "../../../../packages/schema/src/model.js";
import { browserDialectRuntime, type PlaygroundDialect } from "./dialect-browser-runtime.js";
import { PLAYGROUND_DIALECT_LABELS } from "./schema-catalog.js";

export type { PlaygroundDialect } from "./schema-catalog.js";
export { DEFAULT_SCHEMAS, DEFAULT_SOURCES, PLAYGROUND_DIALECT_LABELS, PLAYGROUND_DIALECTS } from "./schema-catalog.js";

export type PlaygroundFile = "schema.sql" | "main.ts";

export interface PlaygroundDiagnostic {
  readonly file: PlaygroundFile;
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly suggestion?: string;
}

export interface PlaygroundQuery {
  readonly binding: string;
  readonly contract: string;
  readonly parameterType: string;
  readonly rowType: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sql: string;
}

export interface PlaygroundResult {
  readonly diagnostics: readonly PlaygroundDiagnostic[];
  readonly queries: readonly PlaygroundQuery[];
}

interface SourcePart {
  readonly text: string;
  readonly start: number;
}

interface ParsedName {
  readonly name: string;
  readonly schema?: string;
}

interface PendingColumn {
  readonly name: string;
  readonly databaseType: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly primaryKey: boolean;
  readonly position: number;
}

const maximumSourceLength = 40_000;

function positionAt(source: string, offset: number): { readonly line: number; readonly column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line, column: offset - lineStart + 1 };
}

function diagnostic(
  source: string,
  file: PlaygroundFile,
  code: string,
  message: string,
  offset = 0,
  suggestion?: string,
): PlaygroundDiagnostic {
  return {
    file,
    code,
    message,
    severity: "error",
    ...positionAt(source, offset),
    ...(suggestion ? { suggestion } : {}),
  };
}

function maskComments(source: string): string {
  const output = [...source];
  let index = 0;
  let quote: "'" | '"' | "`" | undefined;
  while (index < output.length) {
    const char = output[index];
    if (quote !== undefined) {
      if (char === quote && output[index + 1] === quote) index += 2;
      else if (char === quote) {
        quote = undefined;
        index += 1;
      } else index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      index += 1;
    } else if (char === "-" && output[index + 1] === "-") {
      while (index < output.length && output[index] !== "\n") {
        output[index] = " ";
        index += 1;
      }
    } else if (char === "/" && output[index + 1] === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < output.length && !(output[index] === "*" && output[index + 1] === "/")) {
        if (output[index] !== "\n") output[index] = " ";
        index += 1;
      }
      if (index < output.length) {
        output[index] = " ";
        output[index + 1] = " ";
        index += 2;
      }
    } else index += 1;
  }
  return output.join("");
}

function splitTopLevel(source: string, delimiter: "," | ";", baseOffset = 0): readonly SourcePart[] {
  const parts: SourcePart[] = [];
  let depth = 0;
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === quote && source[index + 1] === quote) index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === delimiter && depth === 0) {
      parts.push({ text: source.slice(start, index), start: baseOffset + start });
      start = index + 1;
    }
  }
  parts.push({ text: source.slice(start), start: baseOffset + start });
  return parts.filter(({ text }) => text.trim().length > 0);
}

function identifierParts(value: string): readonly string[] | undefined {
  const raw = value.split(".");
  if (raw.length < 1 || raw.length > 2) return undefined;
  const parts = raw.map((part) => {
    const trimmed = part.trim();
    if (/^"(?:[^"]|"")+"$/u.test(trimmed)) return trimmed.slice(1, -1).replaceAll('""', '"');
    if (/^`(?:[^`]|``)+`$/u.test(trimmed)) return trimmed.slice(1, -1).replaceAll("``", "`");
    return /^[A-Za-z_][\w$]*$/u.test(trimmed) ? trimmed.toLowerCase() : undefined;
  });
  return parts.some((part) => part === undefined) ? undefined : (parts as readonly string[]);
}

function parsedName(value: string): ParsedName | undefined {
  const parts = identifierParts(value);
  if (parts === undefined) return undefined;
  return parts.length === 1 ? { name: parts[0]! } : { schema: parts[0]!, name: parts[1]! };
}

function schemaObjectKey(dialect: PlaygroundDialect, identity: ParsedName): string {
  const namespace = identity.schema ?? (dialect === "postgres" ? "public" : dialect === "mysql" ? "app" : "main");
  const key = `${namespace}.${identity.name}`;
  return dialect === "postgres" ? key : key.toLowerCase();
}

function balancedGroupLength(source: string): number | undefined {
  if (!source.startsWith("(")) return undefined;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) {
        if (source[index + 1] === quote) index += 1;
        else quote = "";
      }
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  return undefined;
}

function columnAttributes(source: string): { nullable: boolean; hasDefault: boolean; primaryKey: boolean } | undefined {
  let remaining = source.trim();
  let nullable = true;
  let explicitNullability: boolean | undefined;
  let hasDefault = false;
  let primaryKey = false;
  while (remaining) {
    const nullability = /^(NOT\s+NULL|NULL)\b/iu.exec(remaining);
    if (nullability) {
      const next = /^NULL$/iu.test(nullability[1]!);
      if ((explicitNullability !== undefined && explicitNullability !== next) || (primaryKey && next)) return undefined;
      nullable = next;
      explicitNullability = next;
      remaining = remaining.slice(nullability[0].length).trim();
      continue;
    }
    const simple = /^(PRIMARY\s+KEY|UNIQUE|AUTO_INCREMENT)\b/iu.exec(remaining);
    if (simple) {
      if (/^PRIMARY/iu.test(simple[0])) {
        if (primaryKey || explicitNullability === true) return undefined;
        primaryKey = true;
        nullable = false;
      }
      if (/^AUTO_INCREMENT$/iu.test(simple[0])) hasDefault = true;
      remaining = remaining.slice(simple[0].length).trim();
      continue;
    }
    const generated = /^GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/iu.exec(remaining);
    if (generated) {
      hasDefault = true;
      remaining = remaining.slice(generated[0].length).trim();
      continue;
    }
    const defaultValue =
      /^DEFAULT\s+('(?:''|[^'])*'|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|NULL\b|TRUE\b|FALSE\b|CURRENT_TIMESTAMP\b(?:\(\d+\))?|CURRENT_DATE\b|CURRENT_TIME\b(?:\(\d+\))?)/iu.exec(
        remaining,
      );
    if (defaultValue) {
      if (hasDefault) return undefined;
      hasDefault = true;
      remaining = remaining.slice(defaultValue[0].length).trim();
      continue;
    }
    const check = /^CHECK\s*/iu.exec(remaining);
    if (check) {
      const group = remaining.slice(check[0].length);
      const length = balancedGroupLength(group);
      if (length === undefined || group.slice(1, length - 1).trim() === "") return undefined;
      remaining = group.slice(length).trim();
      continue;
    }
    const collate = /^COLLATE\s+([A-Za-z_][\w$]*|"(?:[^"]|"")+"|`(?:[^`]|``)+`)/iu.exec(remaining);
    if (collate) {
      remaining = remaining.slice(collate[0].length).trim();
      continue;
    }
    const references = /^REFERENCES\s+([^\s(]+)\s*/iu.exec(remaining);
    if (references) {
      if (!parsedName(references[1]!)) return undefined;
      remaining = remaining.slice(references[0].length);
      if (remaining.startsWith("(")) {
        const length = balancedGroupLength(remaining);
        if (
          length === undefined ||
          !remaining
            .slice(1, length - 1)
            .split(",")
            .every((column) => identifierParts(column.trim())?.length === 1)
        )
          return undefined;
        remaining = remaining.slice(length).trim();
      }
      continue;
    }
    return undefined;
  }
  return { nullable, hasDefault, primaryKey };
}

function columnTypeLength(source: string): number | undefined {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) {
        if (source[index + 1] === quote) index += 1;
        else quote = "";
      }
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      if (--depth < 0) return undefined;
    } else if (
      depth === 0 &&
      /\s/u.test(char) &&
      /^\s+(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|GENERATED|COLLATE|AUTO_INCREMENT)\b/iu.test(
        source.slice(index),
      )
    )
      return index;
  }
  return quote || depth !== 0 ? undefined : source.length;
}

function supportedTableConstraint(source: string): boolean {
  let remaining = source.trim();
  const named = /^CONSTRAINT\s+("(?:[^"]|"")+"|`(?:[^`]|``)+`|[A-Za-z_][\w$]*)\s+/iu.exec(remaining);
  if (named) remaining = remaining.slice(named[0].length);
  const kind = /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\s*/iu.exec(remaining);
  if (!kind) return false;
  remaining = remaining.slice(kind[0].length);
  const length = balancedGroupLength(remaining);
  if (length === undefined) return false;
  const contents = remaining.slice(1, length - 1);
  if (!contents.trim()) return false;
  if (!/^CHECK$/iu.test(kind[1]!) && !contents.split(",").every((name) => identifierParts(name.trim())?.length === 1))
    return false;
  remaining = remaining.slice(length).trim();
  if (/^FOREIGN/iu.test(kind[1]!)) {
    const references = /^REFERENCES\s+([^\s(]+)\s*/iu.exec(remaining);
    if (!references || !parsedName(references[1]!)) return false;
    remaining = remaining.slice(references[0].length);
    const referencedLength = balancedGroupLength(remaining);
    if (
      referencedLength === undefined ||
      !remaining
        .slice(1, referencedLength - 1)
        .split(",")
        .every((name) => identifierParts(name.trim())?.length === 1)
    )
      return false;
    remaining = remaining.slice(referencedLength).trim();
  }
  return remaining.length === 0;
}

function enumLabels(value: string): readonly string[] | undefined {
  const labels: string[] = [];
  for (const { text } of splitTopLevel(value, ",")) {
    const match = /^\s*'((?:[^']|'')*)'\s*$/u.exec(text);
    if (match === null) return undefined;
    labels.push(match[1]!.replaceAll("''", "'"));
  }
  return labels.length > 0 ? labels : undefined;
}

function parseColumn(part: SourcePart, position: number): PendingColumn | undefined {
  const match = /^\s*("(?:[^"]|"")+"|`(?:[^`]|``)+`|[A-Za-z_][\w$]*)\s+([\s\S]+?)\s*$/u.exec(part.text);
  if (match === null) return undefined;
  const name = identifierParts(match[1]!);
  if (name?.length !== 1) return undefined;
  const definition = match[2]!;
  const typeLength = columnTypeLength(definition);
  const databaseType = typeLength === undefined ? undefined : definition.slice(0, typeLength).trim();
  if (databaseType === undefined || databaseType.length === 0) return undefined;
  const attributes = columnAttributes(definition.slice(typeLength));
  if (attributes === undefined) return undefined;
  return {
    name: name[0]!,
    databaseType,
    ...attributes,
    position,
  };
}

function queryBinding(source: string, range: SourceRange, index: number): string {
  const prefix = source.slice(0, range.start);
  const match = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)[^=\n]*=\s*(?:\([^\n)]*\)\s*=>\s*)?$/u.exec(prefix);
  if (match?.[1] !== undefined) return match[1];
  const functionMatch = /(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[\s\S]*\breturn\s*$/u.exec(prefix);
  return functionMatch?.[1] ?? `query${index + 1}`;
}

export function parsePlaygroundSchema(
  dialect: PlaygroundDialect,
  schemaSource: string,
  allowEmpty = false,
): { readonly diagnostics: readonly PlaygroundDiagnostic[]; readonly snapshot?: SchemaSnapshotV2 } {
  if (schemaSource.length > maximumSourceLength) {
    return {
      diagnostics: [
        diagnostic(schemaSource, "schema.sql", "PLAY001", `Schema exceeds ${maximumSourceLength} characters.`),
      ],
    };
  }
  const runtime = browserDialectRuntime(dialect);
  const statements = splitTopLevel(maskComments(schemaSource), ";");
  const diagnostics: PlaygroundDiagnostic[] = [];
  const types: Record<string, TypeSnapshot> = {};
  const declaredTypes = new Set<string>();
  const declaredTables = new Set<string>();
  const pendingRelations: {
    readonly identity: ParsedName;
    readonly columns: readonly PendingColumn[];
    readonly strict: boolean;
  }[] = [];

  for (const statement of statements) {
    const text = statement.text.trim();
    const enumMatch = /^CREATE\s+TYPE\s+([^\s]+)\s+AS\s+ENUM\s*\(([\s\S]*)\)$/iu.exec(text);
    if (enumMatch === null) continue;
    if (dialect !== "postgres") {
      diagnostics.push(
        diagnostic(
          schemaSource,
          "schema.sql",
          "PLAY002",
          "Standalone enum types are only available in the PostgreSQL workspace.",
          statement.start,
        ),
      );
      continue;
    }
    const identity = parsedName(enumMatch[1]!);
    const labels = enumLabels(enumMatch[2]!);
    if (identity === undefined || labels === undefined) {
      diagnostics.push(
        diagnostic(
          schemaSource,
          "schema.sql",
          "PLAY003",
          "Invalid CREATE TYPE ... AS ENUM statement.",
          statement.start,
        ),
      );
      continue;
    }
    const key = identity.schema === undefined ? identity.name : `${identity.schema}.${identity.name}`;
    const canonicalKey = schemaObjectKey(dialect, identity);
    if (declaredTypes.has(canonicalKey)) {
      diagnostics.push(
        diagnostic(
          schemaSource,
          "schema.sql",
          "PLAY207",
          `Duplicate schema declaration ${canonicalKey}.`,
          statement.start,
        ),
      );
      continue;
    }
    declaredTypes.add(canonicalKey);
    types[key] = {
      kind: "enum",
      name: identity.name,
      ...(identity.schema === undefined ? {} : { schema: identity.schema }),
      identity: key,
      databaseType: key,
      labels,
      tsType: labels.map((label) => JSON.stringify(label)).join(" | "),
    };
  }

  for (const statement of statements) {
    const text = statement.text.trim();
    if (/^CREATE\s+TYPE\b/iu.test(text) || (dialect === "sqlite" && /^PRAGMA\b/iu.test(text))) continue;
    const tableMatch =
      /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(([\s\S]*)\)\s*(STRICT)?(?:\s*,?\s*WITHOUT\s+ROWID)?$/iu.exec(
        text,
      );
    if (tableMatch === null) {
      diagnostics.push(
        diagnostic(
          schemaSource,
          "schema.sql",
          "PLAY004",
          "The schema workspace accepts CREATE TABLE statements and PostgreSQL enum types.",
          statement.start,
        ),
      );
      continue;
    }
    const identity = parsedName(tableMatch[1]!);
    if (identity === undefined) {
      diagnostics.push(diagnostic(schemaSource, "schema.sql", "PLAY005", "Invalid table name.", statement.start));
      continue;
    }
    const canonicalKey = schemaObjectKey(dialect, identity);
    if (declaredTables.has(canonicalKey)) {
      diagnostics.push(
        diagnostic(
          schemaSource,
          "schema.sql",
          "PLAY207",
          `Duplicate schema declaration ${canonicalKey}.`,
          statement.start,
        ),
      );
      continue;
    }
    declaredTables.add(canonicalKey);
    const bodyOffset = statement.start + statement.text.indexOf(tableMatch[2]!);
    const columns: PendingColumn[] = [];
    for (const part of splitTopLevel(tableMatch[2]!, ",", bodyOffset)) {
      if (/^\s*(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|CHECK\b|FOREIGN\s+KEY\b)/iu.test(part.text)) {
        if (!supportedTableConstraint(part.text))
          diagnostics.push(
            diagnostic(schemaSource, "schema.sql", "PLAY006", "Invalid or unsupported table constraint.", part.start),
          );
        continue;
      }
      const column = parseColumn(part, columns.length);
      if (column === undefined)
        diagnostics.push(
          diagnostic(schemaSource, "schema.sql", "PLAY006", "Invalid or unsupported column definition.", part.start),
        );
      else if (columns.some(({ name }) => name === column.name))
        diagnostics.push(
          diagnostic(schemaSource, "schema.sql", "PLAY007", `Duplicate column ${column.name}.`, part.start),
        );
      else columns.push(column);
    }
    if (columns.length > 0)
      pendingRelations.push({ identity, columns, strict: dialect === "sqlite" && tableMatch[3] !== undefined });
  }

  if (!allowEmpty && (statements.length === 0 || pendingRelations.length === 0)) {
    diagnostics.push(diagnostic(schemaSource, "schema.sql", "PLAY008", "Add at least one CREATE TABLE statement."));
  }
  if (diagnostics.length > 0) return { diagnostics };

  const server =
    dialect === "postgres"
      ? {
          product: "postgres",
          version: "18.4",
          versionKey: "18",
          features: [],
          settings: { standardConformingStrings: "on", visibilityScope: "current-role" },
        }
      : dialect === "mysql"
        ? { product: "mysql", version: "9.7.0", versionKey: "9.7.0", features: [], settings: {} }
        : { product: "sqlite", version: "3.53.4", versionKey: "3.53.4", features: [], settings: {} };
  const namespace = dialect === "postgres" ? "public" : dialect === "mysql" ? "app" : "main";
  const snapshotBase: SchemaSnapshotV2 = {
    formatVersion: 2,
    dialect,
    dialectVersion: runtime.dialectVersion,
    server,
    namespaces: { [namespace]: { kind: dialect === "mysql" ? "database" : "schema", name: namespace } },
    types,
    relations: {},
    routines: {},
    tables: {},
    enums: Object.fromEntries(
      Object.entries(types).flatMap(([key, type]) => (type.kind === "enum" ? [[key, type.labels]] : [])),
    ),
    domains: {},
    functions: {},
  };
  const relations: Record<string, RelationSnapshot> = Object.fromEntries(
    pendingRelations.map(({ identity, columns, strict }) => {
      const relationSchema = identity.schema ?? namespace;
      const relation: RelationSnapshot = {
        kind: "table" as const,
        name: identity.name,
        schema: relationSchema,
        columns: Object.fromEntries(
          columns.map((column) => [
            column.name,
            {
              name: column.name,
              position: column.position,
              databaseType: column.databaseType,
              typeIdentity: column.databaseType.toLowerCase(),
              tsType: runtime.mapType(column.databaseType, snapshotBase, strict),
              nullable: column.nullable,
              nullabilitySource: "declared",
              default: column.hasDefault ? "present" : "none",
              generated: "none",
              identity:
                column.primaryKey && dialect === "sqlite" && column.databaseType.toUpperCase() === "INTEGER"
                  ? "by-default"
                  : "none",
              classification:
                column.primaryKey && dialect === "sqlite" && column.databaseType.toUpperCase() === "INTEGER"
                  ? "rowid"
                  : "normal",
              insertable: true,
              updatable: true,
            },
          ]),
        ),
        constraints: [],
        indexes: [],
        capabilities: { evidenceComplete: false, ...(dialect === "sqlite" ? { strict, withoutRowid: false } : {}) },
      };
      return [identity.schema === undefined ? identity.name : `${identity.schema}.${identity.name}`, relation];
    }),
  );
  const tables: Record<string, TableSnapshot> = Object.fromEntries(
    Object.entries(relations).map(([key, relation]) => [
      key,
      {
        name: relation.name,
        ...(relation.schema === undefined ? {} : { schema: relation.schema }),
        columns: Object.fromEntries(
          Object.entries(relation.columns).map(([columnKey, value]) => [
            columnKey,
            { name: value.name, databaseType: value.databaseType, tsType: value.tsType, nullable: value.nullable },
          ]),
        ),
      },
    ]),
  );
  return { diagnostics, snapshot: { ...snapshotBase, relations, tables } };
}

export function analyzePlayground(
  dialect: PlaygroundDialect,
  schemaSource: string,
  mainSource: string,
): PlaygroundResult {
  const schema = parsePlaygroundSchema(dialect, schemaSource);
  if (schema.snapshot === undefined) return { diagnostics: schema.diagnostics, queries: [] };
  return analyzePlaygroundSource(dialect, schema.snapshot, mainSource);
}

export function analyzePlaygroundSource(
  dialect: PlaygroundDialect,
  snapshot: SchemaSnapshotV2,
  mainSource: string,
): PlaygroundResult {
  if (mainSource.length > maximumSourceLength) {
    return {
      diagnostics: [
        diagnostic(mainSource, "main.ts", "PLAY101", `TypeScript source exceeds ${maximumSourceLength} characters.`),
      ],
      queries: [],
    };
  }
  const runtime = browserDialectRuntime(dialect);
  const modules = [runtime.module];
  const diagnostics: PlaygroundDiagnostic[] = [];
  const dynamic = extractDynamicQueries(mainSource, modules);
  diagnostics.push(
    ...dynamic.map(({ range }) =>
      diagnostic(
        mainSource,
        "main.ts",
        "PLAY102",
        "Dynamic SQL cannot produce an exact contract.",
        range.start,
        "Keep the SQL template static and interpolate values or explicit fragments.",
      ),
    ),
  );
  const extracted = extractStaticQueries(mainSource, runtime.placeholder, modules);
  if (extracted.length === 0 && dynamic.length === 0) {
    diagnostics.push(
      diagnostic(
        mainSource,
        "main.ts",
        "PLAY103",
        `No typed-sql ${PLAYGROUND_DIALECT_LABELS[dialect]} query was found.`,
        0,
        `Import sql from "${runtime.module}" and use it as a tagged template.`,
      ),
    );
  }

  const queries: PlaygroundQuery[] = [];
  extracted.forEach((query, index) => {
    const repeated = expandRepeatedFragments(mainSource, query, runtime.placeholder);
    if (repeated !== undefined && repeated.diagnostics.length > 0) {
      diagnostics.push(
        ...repeated.diagnostics.map((item): PlaygroundDiagnostic => {
          const end = positionAt(mainSource, item.range.end);
          return {
            file: "main.ts",
            code: item.code,
            message: item.message,
            severity: item.severity === "warning" ? "warning" : "error",
            line: item.range.line,
            column: item.range.column,
            endLine: end.line,
            endColumn: end.column,
            ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
          };
        }),
      );
      return;
    }
    const analyzedQuery = repeated?.query ?? query;
    const analysis = runtime.analyze(analyzedQuery.sql, snapshot);
    diagnostics.push(
      ...analysis.diagnostics.map((item): PlaygroundDiagnostic => {
        const range = mapSqlRange(mainSource, analyzedQuery, item.range);
        const end = positionAt(mainSource, range.end);
        return {
          file: "main.ts",
          code: item.code,
          message: item.message,
          severity: item.severity === "warning" ? "warning" : "error",
          line: range.line,
          column: range.column,
          endLine: end.line,
          endColumn: end.column,
          ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
        };
      }),
    );
    if (analysis.diagnostics.some(({ severity }) => severity === "error")) return;
    const binding = queryBinding(mainSource, query.range, index);
    const rowType = analysis.resultKind === "command" ? "never" : rowTypeLiteral(analysis.columns);
    const rowContract =
      analysis.resultKind === "command"
        ? "  never,"
        : [
            "  {",
            ...analysis.columns.map(
              ({ name, tsType, nullable }) => `    ${JSON.stringify(name)}: ${tsType}${nullable ? " | null" : ""};`,
            ),
            "  },",
          ].join("\n");
    const parameterType =
      repeated?.sites.some(({ dynamic }) => dynamic) === true
        ? "readonly unknown[]"
        : parameterTypeLiteral(analyzedQuery.parameterCount, analysis.parameters);
    queries.push({
      binding,
      rowType,
      parameterType,
      sourceStart: query.range.start,
      sourceEnd: query.range.end,
      sql: analyzedQuery.sql,
      contract: [`const ${binding}: Query<`, rowContract, `  ${parameterType}`, ">;"].join("\n"),
    });
  });
  return { diagnostics, queries };
}
