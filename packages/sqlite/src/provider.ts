import {
  defineSchemaSnapshotV2,
  type FunctionSnapshot,
  fingerprintSchemaExpression,
  type RelationSnapshot,
  type RoutineSnapshot,
  type SchemaInput,
  type SchemaProvider,
  type TypeSnapshot,
} from "@typed-sql/schema";
import { sqliteServerEvidence } from "./capabilities.js";
import {
  sqliteCheckExpressions,
  sqliteColumnCollation,
  sqliteGeneratedExpression,
  sqliteIndexExpression,
  sqliteIndexPredicate,
  sqliteVirtualTableModule,
} from "./schema-sql.js";
import type {
  SqliteForeignKeySnapshot,
  SqliteIndexSnapshot,
  SqliteSchemaSnapshotV2,
  SqliteTableSnapshot,
} from "./snapshot.js";
import { defaultSqliteTypePolicy, mapSqliteCastType, mapSqliteType, type SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface SqliteQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): MaybePromise<readonly Row[]>;
}

export interface SqliteSchemaProviderOptions {
  readonly client: SqliteQueryable;
  readonly schemas?: readonly string[];
  /** @deprecated Use routines to preserve scalar, aggregate, and window kind evidence. */
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
  readonly routines?: Readonly<Record<string, SqliteRoutineDeclaration>>;
  readonly typePolicy?: SqliteTypePolicy;
}

export interface SqliteRoutineArgumentDeclaration {
  readonly databaseType: string;
  readonly tsType?: string;
}

export interface SqliteRoutineResultDeclaration {
  readonly databaseType: string;
  readonly tsType?: string;
  readonly nullable: boolean;
}

/** Explicit application registry for routines installed on an SQLite connection. */
export interface SqliteRoutineDeclaration {
  readonly name: string;
  readonly schema?: string;
  readonly kind: "aggregate" | "scalar" | "window";
  readonly arguments: readonly SqliteRoutineArgumentDeclaration[];
  readonly result: SqliteRoutineResultDeclaration;
  readonly deterministic?: boolean;
  readonly volatility?: "immutable" | "stable" | "volatile";
  readonly nullInput?: "called" | "strict";
}

interface TableListRow extends Record<string, unknown> {
  readonly schema: string;
  readonly name: string;
  readonly type: "shadow" | "table" | "view" | "virtual";
  readonly wr: number | bigint;
  readonly strict: number | bigint;
}

interface CompileOptionRow extends Record<string, unknown> {
  readonly compile_options: string;
}

interface TableXinfoRow extends Record<string, unknown> {
  readonly cid?: number | bigint;
  readonly name: string;
  readonly type: string;
  readonly notnull: number | bigint;
  readonly dflt_value: string | null;
  readonly pk: number | bigint;
  readonly hidden: number | bigint;
}

interface IndexListRow extends Record<string, unknown> {
  readonly seq?: number | bigint;
  readonly name: string;
  readonly unique: number | bigint;
  readonly origin: "c" | "u" | "pk";
  readonly partial: number | bigint;
}

interface IndexXinfoRow extends Record<string, unknown> {
  readonly seqno?: number | bigint;
  readonly name: string | null;
  readonly desc: number | bigint;
  readonly key: number | bigint;
  readonly cid: number | bigint;
  readonly coll: string;
}

interface ForeignKeyRow extends Record<string, unknown> {
  readonly id: number | bigint;
  readonly seq: number | bigint;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
}

interface VersionRow extends Record<string, unknown> {
  readonly version: string;
}

interface DefinitionRow extends Record<string, unknown> {
  readonly name: string;
  readonly tbl_name: string;
  readonly type: "table" | "index" | "view" | "trigger";
  readonly sql: string | null;
}

interface DatabaseListRow extends Record<string, unknown> {
  readonly seq: number | bigint;
  readonly name: string;
  readonly file: string;
}

function identifier(value: string): string {
  if (value.length === 0 || value.includes("\0"))
    throw new TypeError("SQLite identifiers must be non-empty and omit NUL");
  return `"${value.replaceAll('"', '""')}"`;
}

function integer(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

async function all<Row extends Record<string, unknown>>(
  client: SqliteQueryable,
  sql: string,
  values?: readonly unknown[],
): Promise<readonly Row[]> {
  return await client.all<Row>(sql, values);
}

function indexOrigin(origin: IndexListRow["origin"]): SqliteIndexSnapshot["origin"] {
  return origin === "pk" ? "primary-key" : origin === "u" ? "unique" : "create";
}

function foreignKeyAction(
  value: string,
): "no-action" | "restrict" | "cascade" | "set-null" | "set-default" | "unknown" {
  const normalized = value.toUpperCase();
  if (normalized === "NO ACTION") return "no-action";
  if (normalized === "RESTRICT") return "restrict";
  if (normalized === "CASCADE") return "cascade";
  if (normalized === "SET NULL") return "set-null";
  if (normalized === "SET DEFAULT") return "set-default";
  return "unknown";
}

function definitionKey(schema: string, type: string, name: string): string {
  return `${schema}\0${type}\0${name}`;
}

function databaseIdentity(name: string, file: string): string {
  const portableFile = file.split(/[\\/]/u).filter(Boolean).at(-1) ?? "memory";
  return fingerprintSchemaExpression(`${name}:${portableFile}`);
}

async function indexes(
  client: SqliteQueryable,
  schema: string,
  table: string,
): Promise<readonly SqliteIndexSnapshot[]> {
  const rows = await all<IndexListRow>(client, `PRAGMA ${identifier(schema)}.index_list(${identifier(table)})`);
  return await Promise.all(
    [...rows]
      .sort((left, right) => integer(left.seq ?? 0) - integer(right.seq ?? 0))
      .map(async (row) => {
        const columns = await all<IndexXinfoRow>(
          client,
          `PRAGMA ${identifier(schema)}.index_xinfo(${identifier(row.name)})`,
        );
        return {
          name: row.name,
          unique: integer(row.unique) === 1,
          partial: integer(row.partial) === 1,
          origin: indexOrigin(row.origin),
          columns: [...columns]
            .sort((left, right) => integer(left.seqno ?? 0) - integer(right.seqno ?? 0))
            .filter(({ key }) => integer(key) === 1)
            .map((column) => ({
              ...(column.name === null ? {} : { name: column.name }),
              ...(integer(column.cid) < 0 ? { expression: true } : {}),
              ...(integer(column.desc) === 1 ? { descending: true } : {}),
              ...(column.coll.length === 0 ? {} : { collation: column.coll }),
            })),
        };
      }),
  );
}

async function foreignKeys(
  client: SqliteQueryable,
  schema: string,
  table: string,
): Promise<readonly SqliteForeignKeySnapshot[]> {
  const rows = await all<ForeignKeyRow>(client, `PRAGMA ${identifier(schema)}.foreign_key_list(${identifier(table)})`);
  const groups = new Map<number | bigint, ForeignKeyRow[]>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group === undefined) groups.set(row.id, [row]);
    else group.push(row);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => integer(left) - integer(right))
    .map(([, group]) => {
      group.sort((left, right) => integer(left.seq) - integer(right.seq));
      const first = group[0]!;
      return {
        columns: group.map((row) => row.from),
        referencedTable: first.table,
        referencedColumns: group.flatMap((row) => (row.to === null ? [] : [row.to])),
        onUpdate: first.on_update,
        onDelete: first.on_delete,
      };
    });
}

export class SqliteSchemaProvider implements SchemaProvider<SqliteSchemaSnapshotV2> {
  readonly #client: SqliteQueryable;
  readonly #schemas: readonly string[] | undefined;
  readonly #functions: Readonly<Record<string, FunctionSnapshot>> | undefined;
  readonly #routines: Readonly<Record<string, SqliteRoutineDeclaration>> | undefined;
  readonly #policy: SqliteTypePolicy;

  constructor(options: SqliteSchemaProviderOptions) {
    this.#client = options.client;
    this.#schemas = options.schemas;
    this.#functions = options.functions;
    this.#routines = options.routines;
    this.#policy = options.typePolicy ?? defaultSqliteTypePolicy;
  }

  async introspect(_input: SchemaInput = {}): Promise<SqliteSchemaSnapshotV2> {
    const version = (await all<VersionRow>(this.#client, "SELECT sqlite_version() AS version"))[0]?.version;
    const compileOptions = (await all<CompileOptionRow>(this.#client, "PRAGMA compile_options")).map(
      ({ compile_options }) => compile_options,
    );
    const listed = await all<TableListRow>(this.#client, "PRAGMA table_list");
    const databases = await all<DatabaseListRow>(this.#client, "PRAGMA database_list");
    const requested = this.#schemas === undefined ? new Set(["main"]) : new Set(this.#schemas);
    if (requested.size === 0) throw new TypeError("SQLite schema introspection requires at least one schema");
    const selected = listed
      .filter((row) => requested.has(row.schema) && !row.name.startsWith("sqlite_"))
      .sort((left, right) => `${left.schema}\0${left.name}`.localeCompare(`${right.schema}\0${right.name}`));
    const definitions = new Map<string, string>();
    const triggerDefinitions = new Map<string, { readonly name: string; readonly sql: string }[]>();
    for (const schema of [...requested].sort()) {
      const rows = await all<DefinitionRow>(
        this.#client,
        `SELECT name, tbl_name, type, sql FROM ${identifier(schema)}.sqlite_schema WHERE type IN ('table', 'index', 'view', 'trigger')`,
      );
      for (const row of rows) {
        if (row.sql === null) continue;
        definitions.set(definitionKey(schema, row.type, row.name), row.sql);
        if (row.type === "trigger") {
          const key = `${schema}\0${row.tbl_name}`;
          const triggers = triggerDefinitions.get(key);
          const trigger = { name: row.name, sql: row.sql };
          if (triggers === undefined) triggerDefinitions.set(key, [trigger]);
          else triggers.push(trigger);
        }
      }
    }
    const tables: Record<string, SqliteTableSnapshot> = {};
    for (const row of selected) {
      const columns = [
        ...(await all<TableXinfoRow>(
          this.#client,
          `PRAGMA ${identifier(row.schema)}.table_xinfo(${identifier(row.name)})`,
        )),
      ].sort((left, right) => integer(left.cid ?? 0) - integer(right.cid ?? 0));
      const key = requested.size === 1 && row.schema === "main" ? row.name : `${row.schema}.${row.name}`;
      const strict = integer(row.strict) === 1;
      const withoutRowid = integer(row.wr) === 1;
      const tableIndexes = await indexes(this.#client, row.schema, row.name);
      const primaryColumns = columns.filter(({ pk }) => integer(pk) > 0);
      const rowidAlias =
        !withoutRowid &&
        primaryColumns.length === 1 &&
        primaryColumns[0]!.type.trim().toUpperCase() === "INTEGER" &&
        !tableIndexes.some(({ origin }) => origin === "primary-key")
          ? primaryColumns[0]!.name
          : undefined;
      tables[key] = {
        schema: row.schema,
        name: row.name,
        kind: row.type,
        strict,
        withoutRowid,
        ...(rowidAlias === undefined ? {} : { rowidAlias }),
        columns: Object.fromEntries(
          columns.map((column) => [
            column.name,
            {
              name: column.name,
              databaseType: column.type,
              tsType:
                column.name === rowidAlias
                  ? this.#policy.integer
                  : mapSqliteType(column.type, this.#policy, { strict }),
              nullable: integer(column.notnull) !== 1 && column.name !== rowidAlias,
              ...(column.dflt_value === null ? {} : { defaultExpression: column.dflt_value }),
              ...(integer(column.hidden) === 1 ? { hidden: true } : {}),
              ...(integer(column.hidden) === 2 ? { generated: "virtual" as const } : {}),
              ...(integer(column.hidden) === 3 ? { generated: "stored" as const } : {}),
              ...(integer(column.pk) === 0 ? {} : { primaryKeyPosition: integer(column.pk) }),
            },
          ]),
        ),
        indexes: tableIndexes,
        foreignKeys: await foreignKeys(this.#client, row.schema, row.name),
      };
    }
    if (version === undefined) throw new TypeError("SQLite introspection did not return a server version");
    const relations: Record<string, RelationSnapshot> = {};
    const types: Record<string, TypeSnapshot> = {};
    for (const [key, table] of Object.entries(tables)) {
      const tableDefinition = definitions.get(
        definitionKey(table.schema, table.kind === "view" ? "view" : "table", table.name),
      );
      const primaryColumns = Object.values(table.columns)
        .filter(({ primaryKeyPosition }) => (primaryKeyPosition ?? 0) > 0)
        .sort((left, right) => left.primaryKeyPosition! - right.primaryKeyPosition!);
      const constraints: RelationSnapshot["constraints"][number][] = [];
      if (primaryColumns.length > 0) {
        constraints.push({
          kind: "primary-key",
          identity: `${table.schema}.${table.name}.primary-key`,
          columns: primaryColumns.map(({ name }) => name),
          partial: false,
          expressionBased: false,
          deferrable: false,
          initiallyDeferred: false,
          nullsDistinct: false,
        });
      }
      for (const index of table.indexes) {
        if (!index.unique || index.origin === "primary-key") continue;
        constraints.push({
          kind: "unique",
          name: index.name,
          identity: `${table.schema}.${table.name}.${index.name}`,
          columns: index.columns.flatMap(({ name }) => (name === undefined ? [] : [name])),
          partial: index.partial,
          expressionBased: index.columns.some(({ expression }) => expression === true),
          deferrable: false,
          initiallyDeferred: false,
          nullsDistinct: true,
        });
      }
      for (const foreignKey of table.foreignKeys) {
        constraints.push({
          kind: "foreign-key",
          identity: `${table.schema}.${table.name}.foreign-key:${foreignKey.columns.join(",")}->${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(",")})`,
          columns: foreignKey.columns,
          partial: false,
          expressionBased: false,
          deferrable: "unknown",
          initiallyDeferred: "unknown",
          referencedRelation:
            requested.size === 1 ? foreignKey.referencedTable : `${table.schema}.${foreignKey.referencedTable}`,
          referencedColumns: foreignKey.referencedColumns,
          match: "simple",
          onUpdate: foreignKeyAction(foreignKey.onUpdate),
          onDelete: foreignKeyAction(foreignKey.onDelete),
        });
      }
      for (const [position, expression] of sqliteCheckExpressions(tableDefinition).entries()) {
        const predicateHash = fingerprintSchemaExpression(expression);
        constraints.push({
          kind: "check",
          identity: `${table.schema}.${table.name}.check:${position}:${predicateHash}`,
          columns: [],
          partial: false,
          expressionBased: true,
          deferrable: false,
          initiallyDeferred: false,
          predicate: "present",
          predicateHash,
        });
      }
      const triggers = [...(triggerDefinitions.get(`${table.schema}\0${table.name}`) ?? [])]
        .map(({ name, sql }) => ({ name, definitionHash: fingerprintSchemaExpression(sql) }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const module = table.kind === "virtual" ? sqliteVirtualTableModule(tableDefinition) : undefined;
      const extensionAttributes = {
        ...(table.kind === "shadow" ? { objectKind: "shadow" } : {}),
        ...(module === undefined ? {} : { module }),
        ...(triggers.length === 0 ? {} : { triggers }),
      };
      relations[key] = {
        schema: table.schema,
        name: table.name,
        kind: table.kind === "virtual" ? "virtual-table" : table.kind === "shadow" ? "table" : table.kind,
        columns: Object.fromEntries(
          Object.entries(table.columns).map(([columnKey, column], position) => {
            const collation = sqliteColumnCollation(tableDefinition, column.name);
            return [
              columnKey,
              {
                name: column.name,
                position,
                databaseType: column.databaseType || "BLOB",
                typeIdentity: `sqlite:${(column.databaseType || "BLOB").toUpperCase()}`,
                tsType: column.tsType,
                nullable: column.nullable,
                nullabilitySource: column.generated === undefined ? ("declared" as const) : ("generated" as const),
                default: column.defaultExpression === undefined ? ("none" as const) : ("present" as const),
                ...(column.defaultExpression === undefined
                  ? {}
                  : { defaultExpressionHash: fingerprintSchemaExpression(column.defaultExpression) }),
                generated: column.generated ?? ("none" as const),
                ...(column.generated === undefined ||
                sqliteGeneratedExpression(tableDefinition, column.name) === undefined
                  ? {}
                  : {
                      generatedExpressionHash: fingerprintSchemaExpression(
                        sqliteGeneratedExpression(tableDefinition, column.name)!,
                      ),
                    }),
                identity: column.name === table.rowidAlias ? ("by-default" as const) : ("none" as const),
                ...(collation === undefined ? {} : { collation }),
                classification:
                  column.name === table.rowidAlias
                    ? ("rowid" as const)
                    : column.hidden
                      ? ("hidden" as const)
                      : ("normal" as const),
                insertable: column.generated === undefined && !column.hidden && table.kind !== "view",
                updatable: column.generated === undefined && !column.hidden && table.kind !== "view",
              },
            ];
          }),
        ),
        constraints,
        indexes: table.indexes.map((index) => {
          const indexDefinition = definitions.get(definitionKey(table.schema, "index", index.name));
          const predicate = sqliteIndexPredicate(indexDefinition);
          return {
            name: index.name,
            identity: `${table.schema}.${table.name}.${index.name}`,
            unique: index.unique,
            method: "btree",
            columns: index.columns.map((column, offset) => ({
              ...(column.name === undefined
                ? sqliteIndexExpression(indexDefinition, offset) === undefined
                  ? { expressionHash: fingerprintSchemaExpression(`${index.name}:${offset}`) }
                  : { expressionHash: fingerprintSchemaExpression(sqliteIndexExpression(indexDefinition, offset)!) }
                : { column: column.name }),
              ...(column.descending ? { descending: true } : {}),
              ...(column.collation === undefined ? {} : { collation: column.collation }),
            })),
            predicate: index.partial ? (predicate === undefined ? "unknown" : "present") : "none",
            ...(index.partial && predicate !== undefined
              ? { predicateHash: fingerprintSchemaExpression(predicate) }
              : {}),
            valid: true,
            extension: { version: "1", attributes: { origin: index.origin } },
          };
        }),
        capabilities: { strict: table.strict, withoutRowid: table.withoutRowid },
        ...(Object.keys(extensionAttributes).length === 0
          ? {}
          : { extension: { version: "1", attributes: extensionAttributes } }),
      };
      for (const column of Object.values(table.columns)) {
        const databaseType = column.databaseType || "BLOB";
        const typeKey = databaseType.trim().toUpperCase();
        if (types[typeKey] !== undefined) continue;
        const tsType = mapSqliteType(databaseType, this.#policy);
        types[typeKey] =
          tsType === this.#policy.unknown
            ? {
                kind: "opaque",
                name: databaseType,
                identity: `sqlite:${databaseType.toUpperCase()}`,
                databaseType,
                tsType,
                reason: "The SQLite declared type has no configured strict type-policy mapping.",
              }
            : {
                kind: "scalar",
                name: databaseType,
                identity: `sqlite:${databaseType.toUpperCase()}`,
                databaseType,
                tsType,
              };
      }
    }
    const routines: Record<string, RoutineSnapshot[]> = {};
    for (const [identity, fn] of Object.entries(this.#functions ?? {})) {
      const name = `${fn.schema === undefined ? "" : `${fn.schema}.`}${fn.name}`;
      const routine: RoutineSnapshot = {
        name: fn.name,
        ...(fn.schema === undefined ? {} : { schema: fn.schema }),
        identity,
        kind: "function",
        arguments: fn.argumentTypes.map((databaseType) => ({
          mode: "in",
          typeIdentity: `sqlite:${databaseType.toUpperCase()}`,
          databaseType,
          tsType: mapSqliteType(databaseType, this.#policy),
          default: "unknown",
        })),
        result: {
          kind: fn.setReturning ? "set" : "scalar",
          typeIdentity: `sqlite:${(fn.databaseReturnType ?? fn.returnType).toUpperCase()}`,
          databaseType: fn.databaseReturnType ?? fn.returnType,
          tsType: fn.returnType,
          nullable: fn.nullable,
        },
        volatility: fn.volatility ?? "unknown",
        deterministic: fn.volatility === "immutable" ? true : "unknown",
        dataAccess: "unknown",
        nullInput: "unknown",
      };
      const overloads = routines[name];
      if (overloads === undefined) routines[name] = [routine];
      else overloads.push(routine);
    }
    for (const [identity, declaration] of Object.entries(this.#routines ?? {})) {
      const routineName = `${declaration.schema === undefined ? "" : `${declaration.schema}.`}${declaration.name}`;
      const routine: RoutineSnapshot = {
        name: declaration.name,
        ...(declaration.schema === undefined ? {} : { schema: declaration.schema }),
        identity,
        kind: declaration.kind === "scalar" ? "function" : declaration.kind,
        arguments: declaration.arguments.map(({ databaseType, tsType }) => ({
          mode: "in",
          typeIdentity: `sqlite:${databaseType.toUpperCase()}`,
          databaseType,
          tsType: tsType ?? mapSqliteCastType(databaseType, this.#policy),
          default: "none",
        })),
        result: {
          kind: "scalar",
          typeIdentity: `sqlite:${declaration.result.databaseType.toUpperCase()}`,
          databaseType: declaration.result.databaseType,
          tsType: declaration.result.tsType ?? mapSqliteCastType(declaration.result.databaseType, this.#policy),
          nullable: declaration.result.nullable,
        },
        volatility: declaration.volatility ?? (declaration.deterministic === true ? "immutable" : "unknown"),
        deterministic: declaration.deterministic ?? "unknown",
        dataAccess: "unknown",
        nullInput: declaration.nullInput ?? "unknown",
      };
      const overloads = routines[routineName];
      if (overloads === undefined) routines[routineName] = [routine];
      else overloads.push(routine);
    }
    const snapshot = defineSchemaSnapshotV2({
      formatVersion: 2,
      dialect: "sqlite",
      dialectVersion: SQLITE_DIALECT_VERSION,
      server: sqliteServerEvidence(version, compileOptions),
      namespaces: Object.fromEntries(
        [...requested].sort().map((name) => {
          const database = databases.find((candidate) => candidate.name === name);
          return [
            name,
            {
              name,
              kind: "database" as const,
              ...(database === undefined
                ? {}
                : {
                    extension: {
                      version: "1",
                      attributes: {
                        identity: databaseIdentity(name, database.file),
                      },
                    },
                  }),
            },
          ];
        }),
      ),
      types,
      relations,
      routines,
    });
    return {
      ...snapshot,
      tables,
      ...(this.#functions === undefined || Object.keys(this.#functions).length === 0
        ? {}
        : { functions: this.#functions }),
    } as SqliteSchemaSnapshotV2;
  }
}

export async function introspectSqlite(options: SqliteSchemaProviderOptions): Promise<SqliteSchemaSnapshotV2> {
  return new SqliteSchemaProvider(options).introspect();
}
