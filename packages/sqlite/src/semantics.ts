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
import { SQLITE_CURRENT_TIME_KEYWORDS, sqliteBuiltinVolatility } from "./catalog/index.js";
import { type CallExpression, type Statement, type WithClause, walkStatement } from "./parser/index.js";

const builtinVolatility: Readonly<Record<string, QueryVolatility>> = Object.freeze({
  AVG: "immutable",
  COALESCE: "immutable",
  COUNT: "immutable",
  GROUP_CONCAT: "immutable",
  IFNULL: "immutable",
  JSON: "immutable",
  JSON_ARRAY: "immutable",
  JSON_GROUP_ARRAY: "immutable",
  JSON_GROUP_OBJECT: "immutable",
  JSON_EXTRACT: "immutable",
  LENGTH: "immutable",
  MAX: "immutable",
  MIN: "immutable",
  NULLIF: "immutable",
  RANDOM: "volatile",
  SUM: "immutable",
  UUID: "volatile",
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
  const candidates = index.functions(expression.name.name, expression.arguments.length, expression.schema?.name);
  if (candidates.length === 1) return candidates[0]!.volatility ?? "unknown";
  const builtin =
    builtinVolatility[expression.name.name.toUpperCase()] ?? sqliteBuiltinVolatility(expression.name.name);
  return builtin !== undefined && expression.schema === undefined ? builtin : "unknown";
}

function hasRecursiveCte(withClause: WithClause): boolean {
  return withClause.queries.some((query) => {
    let recursive = false;
    walkStatement(query.statement, {
      table(table) {
        if (
          table.kind === "table" &&
          table.schema === undefined &&
          (query.name.quoted
            ? table.name.name === query.name.name
            : table.name.name.toLowerCase() === query.name.name.toLowerCase())
        ) {
          recursive = true;
        }
      },
    });
    return recursive;
  });
}

export function analyzeSqliteSemantics(statement: Statement, snapshot: SchemaSnapshot): QuerySemantics {
  const index = ResolverSchemaIndex.for(snapshot);
  const dependencies = new Map<string, QueryDependency>();
  const capabilities = new Set<string>();
  const volatilities: QueryVolatility[] = [];
  let write = false;
  let hasRelation = false;
  let hasCall = false;
  let hasLockingRead = false;

  walkStatement(statement, {
    statement(current) {
      if (current.kind !== "select") write = true;
      if (current.with !== undefined) capabilities.add(hasRecursiveCte(current.with) ? "recursiveCtes" : "ctes");
      if (current.kind !== "select" && current.returning.length > 0) capabilities.add("returning");
      if (current.kind === "select") {
        if (current.compounds.length > 0) capabilities.add("setOperations");
        if (current.locking.length > 0) {
          hasLockingRead = true;
          capabilities.add("lockingReads");
        }
        if (current.distinctOn.length > 0) capabilities.add("distinctOn");
        if (current.joins.some(({ kind }) => kind === "full")) capabilities.add("fullJoins");
      }
    },
    table(table, owner, context) {
      if (table.kind === "table-function") {
        hasRelation = true;
        hasCall = true;
        capabilities.add("tableFunctions");
        const dependency: QueryDependency = {
          kind: "function",
          access: "execute",
          name: table.name.name,
          ...(table.schema === undefined ? {} : { schema: table.schema.name }),
          certainty: "syntactic",
          range: table.range,
        };
        dependencies.set(key(dependency), dependency);
        volatilities.push("immutable");
        return;
      }
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
        if (
          expression.relation === undefined &&
          !expression.column.quoted &&
          SQLITE_CURRENT_TIME_KEYWORDS.has(expression.column.name.toUpperCase())
        )
          volatilities.push("stable");
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
        if (expression.filter !== undefined) capabilities.add("aggregateFilter");
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
    statement.compounds.length === 0 &&
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
      value: hasLockingRead ? "row" : "none",
      evidence: [
        syntax(
          hasLockingRead ? "A SELECT locking clause acquires row locks." : "The statement contains no locking clause.",
          statement.range,
        ),
      ],
    },
    connectionAffinity: {
      value: hasLockingRead ? "transaction" : "none",
      evidence: [
        syntax(
          hasLockingRead
            ? "A locking read must remain on its primary transaction connection."
            : "The supported statement contains no session or transaction control.",
          statement.range,
        ),
      ],
    },
    capabilities: [...capabilities],
  });
}
