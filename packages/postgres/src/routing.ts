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
import { resolveStatement } from "./resolver.js";
import { analyzePostgresSemantics } from "./semantics.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./type-policy.js";

export interface PostgresQuerySemanticResolverOptions {
  readonly schema: SchemaSnapshot & { readonly dialect: "postgres" };
  readonly typePolicy?: PostgresTypePolicy;
}

export interface PostgresRoutedDatabaseOptions extends PostgresQuerySemanticResolverOptions {
  readonly primary: Database;
  readonly replicas?: readonly Database[];
  readonly selectReplica?: ReplicaSelector;
  readonly observer?: QueryRoutingObserver;
}

/** Resolves runtime query identity with the same PostgreSQL parser and semantic pass as the compiler. */
export function createPostgresQuerySemanticResolver(
  options: PostgresQuerySemanticResolverOptions,
): QuerySemanticResolver {
  const cache = new WeakMap<object, QuerySemantics>();
  const shapes = new Map<string, QuerySemantics>();
  const policy = options.typePolicy ?? defaultPostgresTypePolicy;
  return Object.freeze({
    resolve<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): QuerySemantics {
      const cached = cache.get(query);
      if (cached !== undefined) return cached;
      const source = postgresRendererQuery(query);
      const shape = shapes.get(source);
      if (shape !== undefined) {
        cache.set(query, shape);
        return shape;
      }
      let semantics: QuerySemantics;
      try {
        const statement = parseStatement(source);
        const resolved = resolveStatement(statement, options.schema, { typePolicy: policy });
        semantics = resolved.diagnostics.some(({ severity }) => severity === "error")
          ? unknownQuerySemantics(statement.range, "PostgreSQL runtime semantic analysis reported an error.")
          : analyzePostgresSemantics(statement, options.schema);
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        semantics = unknownQuerySemantics(
          error.range,
          "The runtime SQL could not be parsed by the PostgreSQL grammar.",
        );
      }
      if (shapes.size >= 1_024) shapes.delete(shapes.keys().next().value!);
      shapes.set(source, semantics);
      cache.set(query, semantics);
      return semantics;
    },
  });
}

function postgresRendererQuery<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): string {
  const chunks: string[] = [];
  let parameter = 0;
  for (const segment of query.segments) {
    if (segment.kind === "text") chunks.push(segment.text);
    else if (segment.kind === "identifier") chunks.push(`"${segment.name.replaceAll('"', '""')}"`);
    else chunks.push(`$${++parameter}`);
  }
  return chunks.join("");
}

/** Composes application-owned PostgreSQL databases into a conservative routed database. */
export function createPostgresRoutedDatabase(options: PostgresRoutedDatabaseOptions): RoutedDatabase {
  return createRoutedDatabase({
    primary: options.primary,
    ...(options.replicas === undefined ? {} : { replicas: options.replicas }),
    semantics: createPostgresQuerySemanticResolver(options),
    ...(options.selectReplica === undefined ? {} : { selectReplica: options.selectReplica }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
}

/** PostgreSQL recommends retrying complete transactions for serialization failures and deadlocks. */
export function isPostgresRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error.code === "40001" || error.code === "40P01")
  );
}
