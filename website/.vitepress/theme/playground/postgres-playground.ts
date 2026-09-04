import { parameterTypeLiteral, rowTypeLiteral, type SourceRange } from "@typed-sql/core";
import { extractDynamicQueries, extractStaticQueries, mapSqlRange } from "../../../../packages/compiler/src/scanner.js";
import {
  analyzePostgres,
  defaultPostgresTypePolicy,
  mapPostgresType,
  POSTGRES_DIALECT_VERSION,
  type PostgresSchemaSnapshot,
} from "./postgres-browser-runtime.js";

export const DEFAULT_PLAYGROUND_SCHEMA = `CREATE TYPE account_status AS ENUM ('active', 'suspended');

CREATE TABLE users (
  id bigint PRIMARY KEY,
  email text NOT NULL,
  status account_status NOT NULL DEFAULT 'active'
);`;

export const DEFAULT_PLAYGROUND_SOURCE = `import { sql } from "@typed-sql/postgres";

const accountId: bigint = 42n;

const accountById = sql\`
  SELECT id, email, status
  FROM users
  WHERE id = \${accountId}
\`;`;

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
  readonly sql: string;
}

export interface PostgresPlaygroundResult {
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
  readonly position: number;
}

interface PendingRelation {
  readonly identity: ParsedName;
  readonly columns: readonly PendingColumn[];
}

const postgresSqlModules = ["@typed-sql/postgres"] as const;
const postgresPlaceholder = (index: number) => `$${index}`;
const maximumSourceLength = 24_000;

function positionAt(source: string, offset: number): { readonly line: number; readonly column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line, column: offset - lineStart + 1 };
}

function localDiagnostic(
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
  let quote: "'" | '"' | undefined;
  while (index < output.length) {
    const char = output[index];
    if (quote !== undefined) {
      if (char === quote && output[index + 1] === quote) index += 2;
      else if (char === quote) {
        quote = undefined;
        index += 1;
      } else index += 1;
    } else if (char === "'" || char === '"') {
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
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === quote && source[index + 1] === quote) index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
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
  const parts = splitTopLevel(value, ",").flatMap(({ text }) => text.split("."));
  if (parts.length < 1 || parts.length > 2) return undefined;
  const parsed = parts.map((part) => {
    const trimmed = part.trim();
    if (/^"(?:[^"]|"")+"$/u.test(trimmed)) return trimmed.slice(1, -1).replaceAll('""', '"');
    return /^[A-Za-z_][\w$]*$/u.test(trimmed) ? trimmed.toLowerCase() : undefined;
  });
  return parsed.some((part) => part === undefined) ? undefined : (parsed as readonly string[]);
}

function parsedName(value: string): ParsedName | undefined {
  const parts = identifierParts(value);
  if (parts === undefined) return undefined;
  return parts.length === 1 ? { name: parts[0]! } : { schema: parts[0]!, name: parts[1]! };
}

function parseEnumLabels(value: string): readonly string[] | undefined {
  const labels: string[] = [];
  for (const { text } of splitTopLevel(value, ",")) {
    const match = /^\s*'((?:[^']|'')*)'\s*$/u.exec(text);
    if (match === null) return undefined;
    labels.push(match[1]!.replaceAll("''", "'"));
  }
  return labels.length > 0 ? labels : undefined;
}

function parseColumn(part: SourcePart, position: number): PendingColumn | undefined {
  const match = /^\s*("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s+([\s\S]+?)\s*$/u.exec(part.text);
  if (match === null) return undefined;
  const name = identifierParts(match[1]!);
  if (name?.length !== 1) return undefined;
  const definition = match[2]!;
  const typeMatch =
    /^([\s\S]*?)(?=\s+(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|GENERATED|COLLATE)\b|$)/iu.exec(
      definition,
    );
  const databaseType = typeMatch?.[1]?.trim();
  if (databaseType === undefined || databaseType.length === 0) return undefined;
  return {
    name: name[0]!,
    databaseType,
    nullable: !/\b(?:NOT\s+NULL|PRIMARY\s+KEY)\b/iu.test(definition),
    hasDefault: /\bDEFAULT\b/iu.test(definition),
    position,
  };
}

function queryBinding(source: string, range: SourceRange, index: number): string {
  const prefix = source.slice(0, range.start);
  const match = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)[^=\n]*=\s*(?:\([^\n)]*\)\s*=>\s*)?$/u.exec(prefix);
  return match?.[1] ?? `query${index + 1}`;
}

function playgroundSnapshot(schemaSource: string): {
  readonly diagnostics: readonly PlaygroundDiagnostic[];
  readonly snapshot?: PostgresSchemaSnapshot;
} {
  if (schemaSource.length > maximumSourceLength) {
    return {
      diagnostics: [
        localDiagnostic(schemaSource, "schema.sql", "PLAY001", `Schema exceeds ${maximumSourceLength} characters.`),
      ],
    };
  }
  const masked = maskComments(schemaSource);
  const statements = splitTopLevel(masked, ";");
  const diagnostics: PlaygroundDiagnostic[] = [];
  const types: Record<string, Record<string, unknown>> = {};
  const relations: PendingRelation[] = [];

  for (const statement of statements) {
    const text = statement.text.trim();
    const enumMatch = /^CREATE\s+TYPE\s+([^\s]+)\s+AS\s+ENUM\s*\(([\s\S]*)\)$/iu.exec(text);
    if (enumMatch === null) continue;
    const identity = parsedName(enumMatch[1]!);
    const labels = parseEnumLabels(enumMatch[2]!);
    if (identity === undefined || labels === undefined) {
      diagnostics.push(
        localDiagnostic(
          schemaSource,
          "schema.sql",
          "PLAY002",
          "Invalid CREATE TYPE ... AS ENUM statement.",
          statement.start,
        ),
      );
      continue;
    }
    const key = identity.schema === undefined ? identity.name : `${identity.schema}.${identity.name}`;
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
    if (/^CREATE\s+TYPE\b/iu.test(text)) continue;
    const tableMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(([\s\S]*)\)$/iu.exec(text);
    if (tableMatch === null) {
      diagnostics.push(
        localDiagnostic(
          schemaSource,
          "schema.sql",
          "PLAY003",
          "This playground accepts CREATE TYPE ... AS ENUM and CREATE TABLE statements.",
          statement.start,
        ),
      );
      continue;
    }
    const identity = parsedName(tableMatch[1]!);
    if (identity === undefined) {
      diagnostics.push(localDiagnostic(schemaSource, "schema.sql", "PLAY004", "Invalid table name.", statement.start));
      continue;
    }
    const bodyOffset = statement.start + statement.text.indexOf(tableMatch[2]!);
    const columns: PendingColumn[] = [];
    for (const part of splitTopLevel(tableMatch[2]!, ",", bodyOffset)) {
      if (/^\s*(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|CHECK\b|FOREIGN\s+KEY\b)/iu.test(part.text)) continue;
      const column = parseColumn(part, columns.length);
      if (column === undefined) {
        diagnostics.push(
          localDiagnostic(schemaSource, "schema.sql", "PLAY005", "Invalid column definition.", part.start),
        );
      } else if (columns.some(({ name }) => name === column.name)) {
        diagnostics.push(
          localDiagnostic(schemaSource, "schema.sql", "PLAY006", `Duplicate column ${column.name}.`, part.start),
        );
      } else columns.push(column);
    }
    if (columns.length > 0) relations.push({ identity, columns });
  }

  if (statements.length === 0) {
    diagnostics.push(
      localDiagnostic(schemaSource, "schema.sql", "PLAY007", "Add at least one CREATE TABLE statement."),
    );
  }
  if (diagnostics.length > 0) return { diagnostics };

  const snapshotBase = {
    formatVersion: 2 as const,
    dialect: "postgres" as const,
    dialectVersion: POSTGRES_DIALECT_VERSION,
    server: {
      product: "postgres",
      version: "18.4",
      versionKey: "18",
      features: [],
      settings: { standardConformingStrings: "on", visibilityScope: "current-role" },
    },
    namespaces: { public: { kind: "schema" as const, name: "public" } },
    types,
    relations: {},
    routines: {},
  } as unknown as PostgresSchemaSnapshot;
  const resolvedRelations = Object.fromEntries(
    relations.map(({ identity, columns }) => [
      identity.name,
      {
        kind: "table",
        name: identity.name,
        schema: identity.schema ?? "public",
        columns: Object.fromEntries(
          columns.map((column) => [
            column.name,
            {
              name: column.name,
              position: column.position,
              databaseType: column.databaseType,
              typeIdentity: column.databaseType.toLowerCase(),
              tsType: mapPostgresType(column.databaseType, defaultPostgresTypePolicy, snapshotBase),
              nullable: column.nullable,
              nullabilitySource: "declared",
              default: column.hasDefault ? "present" : "none",
              generated: "none",
              identity: "none",
              classification: "normal",
              insertable: true,
              updatable: true,
            },
          ]),
        ),
        constraints: [],
        indexes: [],
        capabilities: { evidenceComplete: false },
      },
    ]),
  );
  const tables = Object.fromEntries(
    Object.entries(resolvedRelations).map(([key, relation]) => [
      key,
      {
        name: relation.name,
        schema: relation.schema,
        columns: Object.fromEntries(
          Object.entries(relation.columns).map(([columnKey, column]) => [
            columnKey,
            {
              name: column.name,
              databaseType: column.databaseType,
              tsType: column.tsType,
              nullable: column.nullable,
            },
          ]),
        ),
      },
    ]),
  );
  const enums = Object.fromEntries(
    Object.entries(types)
      .filter(([, type]) => type.kind === "enum")
      .map(([key, type]) => [key, type.labels]),
  );
  return {
    diagnostics,
    snapshot: { ...snapshotBase, relations: resolvedRelations, tables, enums } as PostgresSchemaSnapshot,
  };
}

export function analyzePostgresPlayground(schemaSource: string, mainSource: string): PostgresPlaygroundResult {
  const schema = playgroundSnapshot(schemaSource);
  if (schema.snapshot === undefined) return { diagnostics: schema.diagnostics, queries: [] };
  if (mainSource.length > maximumSourceLength) {
    return {
      diagnostics: [
        localDiagnostic(
          mainSource,
          "main.ts",
          "PLAY101",
          `TypeScript source exceeds ${maximumSourceLength} characters.`,
        ),
      ],
      queries: [],
    };
  }

  const diagnostics: PlaygroundDiagnostic[] = [...schema.diagnostics];
  const dynamic = extractDynamicQueries(mainSource, postgresSqlModules);
  diagnostics.push(
    ...dynamic.map(({ range }) => ({
      ...localDiagnostic(
        mainSource,
        "main.ts",
        "PLAY102",
        "Dynamic SQL cannot produce an exact contract.",
        range.start,
        "Keep the SQL template static and interpolate values or explicit fragments.",
      ),
    })),
  );
  const extracted = extractStaticQueries(mainSource, postgresPlaceholder, postgresSqlModules);
  if (extracted.length === 0 && dynamic.length === 0) {
    diagnostics.push(
      localDiagnostic(
        mainSource,
        "main.ts",
        "PLAY103",
        "No typed-sql PostgreSQL query was found.",
        0,
        'Import sql from "@typed-sql/postgres" and use it as a tagged template.',
      ),
    );
  }

  const queries: PlaygroundQuery[] = [];
  extracted.forEach((query, index) => {
    const analysis = analyzePostgres(query.sql, schema.snapshot!);
    diagnostics.push(
      ...analysis.diagnostics.map((diagnostic): PlaygroundDiagnostic => {
        const range = mapSqlRange(mainSource, query, diagnostic.range);
        const end = positionAt(mainSource, range.end);
        return {
          file: "main.ts",
          code: diagnostic.code,
          message: diagnostic.message,
          severity: diagnostic.severity === "warning" ? "warning" : "error",
          line: range.line,
          column: range.column,
          endLine: end.line,
          endColumn: end.column,
          ...(diagnostic.suggestion === undefined ? {} : { suggestion: diagnostic.suggestion }),
        };
      }),
    );
    if (analysis.diagnostics.some(({ severity }) => severity === "error")) return;
    const binding = queryBinding(mainSource, query.range, index);
    const rowType = analysis.resultKind === "command" ? "never" : rowTypeLiteral(analysis.columns);
    const parameterType = parameterTypeLiteral(query.parameterCount, analysis.parameters);
    queries.push({
      binding,
      rowType,
      parameterType,
      sql: query.sql,
      contract: [`const ${binding}: Query<`, `  ${rowType},`, `  ${parameterType}`, ">;"].join("\n"),
    });
  });

  return { diagnostics, queries };
}
