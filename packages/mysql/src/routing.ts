import {
  createRoutedDatabase,
  type Database,
  type Query,
  type QueryRoutingObserver,
  type QuerySemanticResolver,
  type QuerySemantics,
  type ReplicaSelector,
  type RoutedDatabase,
  unknownQuerySemantics,
} from "@typed-sql/core";
import type { SchemaSnapshot } from "@typed-sql/schema";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { resolveMySqlStatement } from "./resolver.js";
import { analyzeMySqlSemantics } from "./semantics.js";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";

export interface MySqlQuerySemanticResolverOptions {
  readonly schema: SchemaSnapshot & { readonly dialect: "mysql" };
  readonly typePolicy?: MySqlTypePolicy;
}

export interface MySqlRoutedDatabaseOptions extends MySqlQuerySemanticResolverOptions {
  readonly primary: Database;
  readonly replicas?: readonly Database[];
  readonly selectReplica?: ReplicaSelector;
  readonly observer?: QueryRoutingObserver;
}

/** Resolves runtime query identity with the same MySQL parser and semantic pass as the compiler. */
export function createMySqlQuerySemanticResolver(options: MySqlQuerySemanticResolverOptions): QuerySemanticResolver {
  const cache = new WeakMap<object, QuerySemantics>();
  const shapes = new Map<string, QuerySemantics>();
  const policy = options.typePolicy ?? defaultMySqlTypePolicy;
  return Object.freeze({
    resolve<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): QuerySemantics {
      const cached = cache.get(query);
      if (cached !== undefined) return cached;
      const source = mysqlRendererQuery(query);
      const shape = shapes.get(source);
      if (shape !== undefined) {
        cache.set(query, shape);
        return shape;
      }
      let semantics: QuerySemantics;
      try {
        const sqlMode = options.schema.server?.settings.sqlMode;
        const statement = parseStatement(source, { ...(typeof sqlMode === "string" ? { sqlMode } : {}) });
        const resolved = resolveMySqlStatement(statement, options.schema, { typePolicy: policy });
        semantics = resolved.diagnostics.some(({ severity }) => severity === "error")
          ? unknownQuerySemantics(statement.range, "MySQL runtime semantic analysis reported an error.")
          : analyzeMySqlSemantics(statement, options.schema);
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        semantics = unknownQuerySemantics(error.range, "The runtime SQL could not be parsed by the MySQL grammar.");
      }
      if (shapes.size >= 1_024) shapes.delete(shapes.keys().next().value!);
      shapes.set(source, semantics);
      cache.set(query, semantics);
      return semantics;
    },
  });
}

function mysqlRendererQuery<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): string {
  const chunks: string[] = [];
  for (const segment of query.segments) {
    if (segment.kind === "text") chunks.push(segment.text);
    else if (segment.kind === "identifier") chunks.push(`\`${segment.name.replaceAll("`", "``")}\``);
    else chunks.push("?");
  }
  return chunks.join("");
}

/** Composes application-owned MySQL databases into a conservative routed database. */
export function createMySqlRoutedDatabase(options: MySqlRoutedDatabaseOptions): RoutedDatabase {
  return createRoutedDatabase({
    primary: options.primary,
    ...(options.replicas === undefined ? {} : { replicas: options.replicas }),
    semantics: createMySqlQuerySemanticResolver(options),
    ...(options.selectReplica === undefined ? {} : { selectReplica: options.selectReplica }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
}

/** MySQL explicitly instructs applications to retry complete transactions after an InnoDB deadlock. */
export function isMySqlRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly code?: unknown; readonly errno?: unknown; readonly sqlState?: unknown };
  return value.code === "ER_LOCK_DEADLOCK" || value.errno === 1213 || value.sqlState === "40001";
}
