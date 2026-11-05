import {
  defineQuerySemantics,
  QUERY_SEMANTICS_VERSION,
  type QueryDependency,
  type QuerySemantics,
} from "@typed-sql/core";
import { SQLSERVER_BUILTINS } from "./catalog/index.js";
import { type Statement, walkExpression, walkStatement } from "./parser/index.js";
export function analyzeSqlServerSemantics(statement: Statement): QuerySemantics {
  const evidence = [
    {
      kind: "syntax" as const,
      description: `SQL Server ${statement.kind.toUpperCase()} statement`,
      range: statement.range,
    },
  ];
  const dependencies: QueryDependency[] = [];
  const capabilities = new Set<string>(["syntax"]);
  let volatility: "immutable" | "stable" | "volatile" | "unknown" = "immutable";
  let locking: "none" | "row" | "table" | "unknown" = "none";
  let session = false,
    aggregate = false;
  walkStatement(statement, {
    statement(value) {
      if (value.with.length) capabilities.add("ctes");
      if (value.kind === "select") {
        if (value.top) capabilities.add("top");
        if (value.offset || value.fetch) capabilities.add("pagination");
        if (value.compounds.length) capabilities.add("setOperations");
        if (value.joins.some((join) => join.kind.includes("apply"))) capabilities.add("apply");
        if (value.joins.some((join) => join.kind === "full")) capabilities.add("fullJoins");
        if (value.forJson) capabilities.add("json");
      } else {
        dependencies.push({
          kind: "relation",
          access: "write",
          name: value.target.parts.at(-1)!,
          ...(value.target.parts.length > 1 ? { schema: value.target.parts.at(-2)! } : {}),
          certainty: "resolved",
          range: value.target.range,
        });
        if (value.output) capabilities.add("output");
      }
    },
    source(source) {
      if (source.kind === "table") {
        dependencies.push({
          kind: "relation",
          access: "read",
          name: source.name.parts.at(-1)!,
          ...(source.name.parts.length > 1 ? { schema: source.name.parts.at(-2)! } : {}),
          certainty: "resolved",
          range: source.name.range,
        });
        if (source.name.parts.some((part) => part.startsWith("#"))) session = true;
        if (source.hints.includes("TABLOCKX") || source.hints.includes("TABLOCK")) locking = "table";
        else if (source.hints.includes("UPDLOCK") || source.hints.includes("HOLDLOCK"))
          locking = locking === "table" ? "table" : "row";
      }
    },
    expression(expression) {
      if (expression.kind === "column")
        dependencies.push({
          kind: "column",
          access: "reference",
          name: expression.name.parts.at(-1)!,
          ...(expression.name.parts.length > 1 ? { parent: expression.name.parts.at(-2)! } : {}),
          certainty: "resolved",
          range: expression.range,
        });
      if (expression.kind === "system") {
        session = true;
        volatility = "volatile";
      }
      if (expression.kind === "call") {
        const name = expression.name.parts.at(-1)!.toUpperCase(),
          builtin = expression.name.parts.length === 1 ? SQLSERVER_BUILTINS[name] : undefined;
        dependencies.push({
          kind: "function",
          access: "execute",
          name,
          ...(expression.name.parts.length > 1 ? { schema: expression.name.parts.at(-2)! } : {}),
          certainty: builtin ? "resolved" : "syntactic",
          range: expression.range,
        });
        if (!builtin) volatility = "unknown";
        else if (builtin.volatility === "volatile") volatility = "volatile";
        else if (builtin.volatility === "stable" && volatility === "immutable") volatility = "stable";
        if (expression.over) capabilities.add("windows");
        if (expression.returningJson) capabilities.add("nativeJson");

        if (name.startsWith("JSON_") || name === "OPENJSON") capabilities.add("json");
      }
      if (expression.kind === "cast" && expression.databaseType === "json") capabilities.add("nativeJson");
    },
  });
  if (statement.kind === "select") {
    const subqueries: { start: number; end: number }[] = [];
    const inspect = (expression: Parameters<typeof walkExpression>[0]) =>
      walkExpression(expression, {
        expression(value) {
          if (value.kind === "subquery" || value.kind === "exists") subqueries.push(value.range);
          if (
            value.kind === "call" &&
            value.name.parts.length === 1 &&
            SQLSERVER_BUILTINS[value.name.parts[0]!.toUpperCase()]?.kind === "aggregate" &&
            !value.over &&
            !subqueries.some((range) => value.range.start >= range.start && value.range.end <= range.end)
          )
            aggregate = true;
        },
      });
    for (const projection of statement.projections) inspect(projection.expression);
    if (statement.having) inspect(statement.having);
  }
  const write = statement.kind !== "select";
  const command = write && (!statement.output || statement.output.into !== undefined);
  const single =
    statement.kind === "select" &&
    (!statement.from || (aggregate && !statement.group.length)) &&
    !statement.compounds.length &&
    !statement.forJson;
  const oneTop =
    statement.kind === "select" &&
    statement.top?.count.kind === "literal" &&
    String(statement.top.count.value) === "1" &&
    !statement.top.percent &&
    !statement.top.ties;
  return defineQuerySemantics({
    version: QUERY_SEMANTICS_VERSION,
    operation: { value: write ? "write" : "read", evidence },
    dependencies,
    cardinality: {
      minimum: command
        ? 0
        : single &&
            statement.kind === "select" &&
            !statement.where &&
            !statement.having &&
            !statement.top &&
            !statement.offset &&
            !statement.fetch
          ? 1
          : 0,
      maximum: command ? 0 : single || oneTop ? 1 : "many",
      evidence,
    },
    volatility: { value: volatility, evidence },
    locking: { value: locking, evidence },
    connectionAffinity: { value: session ? "session" : write || locking !== "none" ? "transaction" : "none", evidence },
    capabilities: [...capabilities],
  });
}
