import { type CallExpression, type Statement, walkStatement } from "@typed-sql/ast";
import {
  defineQuerySemantics,
  QUERY_SEMANTICS_VERSION,
  type QueryDependency,
  type QuerySemantics,
  type QueryVolatility,
  ResolverSchemaIndex,
  type SemanticEvidence,
} from "@typed-sql/core";
import type { SchemaSnapshot } from "@typed-sql/schema";

const builtinVolatility: Readonly<Record<string, QueryVolatility>> = Object.freeze({
  ARRAY_AGG: "immutable",
  AVG: "immutable",
  BOOL_AND: "immutable",
  BOOL_OR: "immutable",
  COALESCE: "immutable",
  COUNT: "immutable",
  CURRVAL: "volatile",
  EVERY: "immutable",
  GREATEST: "immutable",
  JSON_AGG: "immutable",
  JSON_OBJECT_AGG: "immutable",
  JSONB_AGG: "immutable",
  JSONB_OBJECT_AGG: "immutable",
  LEAST: "immutable",
  MAX: "immutable",
  MIN: "immutable",
  NEXTVAL: "volatile",
  NULLIF: "immutable",
  RANDOM: "volatile",
  SETVAL: "volatile",
  STRING_AGG: "immutable",
  SUM: "immutable",
});

function syntax(description: string, range: Statement["range"]): SemanticEvidence {
  return { kind: "syntax", description, range };
}

function key(dependency: QueryDependency): string {
  return [
    dependency.kind,
    dependency.access,
    dependency.schema ?? "",
    dependency.parent ?? "",
    dependency.name,
    dependency.range.start,
  ].join("\0");
}

function functionVolatility(expression: CallExpression, index: ResolverSchemaIndex): QueryVolatility {
  const builtin = builtinVolatility[expression.name.name.toUpperCase()];
  if (builtin !== undefined && expression.schema === undefined) return builtin;
  const candidates = index.functions(expression.name.name, expression.arguments.length, expression.schema?.name);
  return candidates.length === 1 ? (candidates[0]!.volatility ?? "unknown") : "unknown";
}

export function analyzePostgresSemantics(statement: Statement, snapshot: SchemaSnapshot): QuerySemantics {
  const index = ResolverSchemaIndex.for(snapshot);
  const dependencies = new Map<string, QueryDependency>();
  const capabilities = new Set<string>();
  const volatilities: QueryVolatility[] = [];
  let write = false;
  let hasRelation = false;
  let hasCall = false;

  walkStatement(statement, {
    statement(current) {
      if (current.kind !== "select") write = true;
      if (current.with !== undefined) capabilities.add(current.with.recursive ? "recursiveCtes" : "ctes");
      if (current.kind !== "select" && current.returning.length > 0) capabilities.add("returning");
    },
    table(table, owner, context) {
      if (
        table.kind !== "table" ||
        (table.schema === undefined &&
          context.ctes.some((cte) =>
            cte.quoted ? cte.name === table.name.name : cte.name.toLowerCase() === table.name.name.toLowerCase(),
          ))
      )
        return;
      hasRelation = true;
      const matches = index.tables(table.name.name, table.schema?.name, table.name.quoted || table.schema?.quoted);
      const resolved = matches.length === 1 ? matches[0] : undefined;
      const schema = resolved?.table.schema ?? table.schema?.name;
      const dependency: QueryDependency = {
        kind: "relation",
        access: owner.kind !== "select" && owner.table === table ? "write" : "read",
        name: resolved?.table.name ?? table.name.name,
        ...(schema === undefined ? {} : { schema }),
        certainty: resolved === undefined ? "syntactic" : "resolved",
        range: table.range,
      };
      dependencies.set(key(dependency), dependency);
    },
    expression(expression, owner) {
      if (expression.kind === "column") {
        const dependency: QueryDependency = {
          kind: "column",
          access: owner.kind === "select" ? "read" : "unknown",
          name: expression.column.name,
          ...(expression.relation === undefined ? {} : { parent: expression.relation.name }),
          certainty: "syntactic",
          range: expression.range,
        };
        dependencies.set(key(dependency), dependency);
      } else if (expression.kind === "call") {
        hasCall = true;
        if (expression.over !== undefined) capabilities.add("windows");
        const candidates = index.functions(expression.name.name, expression.arguments.length, expression.schema?.name);
        const resolved = candidates.length === 1 ? candidates[0] : undefined;
        const schema = resolved?.schema ?? expression.schema?.name;
        const dependency: QueryDependency = {
          kind: "function",
          access: "execute",
          name: resolved?.name ?? expression.name.name,
          ...(schema === undefined ? {} : { schema }),
          certainty: resolved === undefined ? "syntactic" : "resolved",
          range: expression.range,
        };
        dependencies.set(key(dependency), dependency);
        volatilities.push(functionVolatility(expression, index));
      } else if (expression.kind === "array") capabilities.add("arrays");
      else if (expression.kind === "cast") capabilities.add("casts");
      else if (expression.kind === "subquery" || expression.kind === "exists") capabilities.add("subqueries");
    },
    type(type) {
      const dependency: QueryDependency = {
        kind: "type",
        access: "reference",
        name: type.name,
        certainty: "syntactic",
        range: type.range,
      };
      dependencies.set(key(dependency), dependency);
    },
  });

  const operationEvidence = syntax(
    write ? "A data-changing statement occurs in the query tree." : "Every statement in the query tree is SELECT.",
    statement.range,
  );
  const volatility: QueryVolatility = write
    ? "volatile"
    : volatilities.includes("unknown")
      ? "unknown"
      : volatilities.includes("volatile")
        ? "volatile"
        : volatilities.includes("stable") || hasRelation
          ? "stable"
          : "immutable";
  const exactOne =
    statement.kind === "select" &&
    statement.from === undefined &&
    statement.joins.length === 0 &&
    statement.where === undefined &&
    statement.groupBy.length === 0 &&
    statement.having === undefined &&
    statement.limit === undefined &&
    statement.offset === undefined &&
    !hasCall;
  const command = statement.kind !== "select" && statement.returning.length === 0;

  return defineQuerySemantics({
    version: QUERY_SEMANTICS_VERSION,
    operation: { value: write ? "write" : "read", evidence: [operationEvidence] },
    dependencies: [...dependencies.values()],
    cardinality: {
      minimum: exactOne ? 1 : 0,
      maximum: command ? 0 : exactOne ? 1 : "many",
      evidence: [
        syntax(
          command
            ? "The command has no RETURNING clause."
            : exactOne
              ? "A scalar SELECT without row-eliminating clauses returns one row."
              : "The statement can return a data-dependent number of rows.",
          statement.range,
        ),
      ],
    },
    volatility: {
      value: volatility,
      evidence: [
        syntax(
          write
            ? "Writes are volatile."
            : hasCall
              ? "Function volatility is derived from grammar built-ins and schema evidence."
              : hasRelation
                ? "Reading a relation is stable for the statement."
                : "The statement contains only immutable syntax.",
          statement.range,
        ),
      ],
    },
    locking: {
      value: "none",
      evidence: [syntax("The supported statement contains no locking clause.", statement.range)],
    },
    connectionAffinity: {
      value: "none",
      evidence: [syntax("The supported statement contains no session or transaction control.", statement.range)],
    },
    capabilities: [...capabilities],
  });
}
