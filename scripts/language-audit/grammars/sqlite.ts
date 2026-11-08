import { sqlite } from "../../../packages/sqlite/src/analysis.js";
import { SQLITE_BUILTIN_FUNCTIONS } from "../../../packages/sqlite/src/catalog/functions.js";
import { SQLITE_JSON_TABLE_FUNCTIONS } from "../../../packages/sqlite/src/catalog/json.js";
import { tokenize as tokenizeSqlite } from "../../../packages/sqlite/src/parser/tokenizer.js";
import { callProbeQueries } from "../invocations.js";
import type { AuditGrammar } from "./contracts.js";
import { sqlInvocationShapeSyntax } from "./shape-syntax.js";
import { standardEntityProbe } from "./sql-probes.js";

export const sqliteAudit: AuditGrammar = {
  id: "sqlite",
  invocationShapeSyntax: sqlInvocationShapeSyntax({
    quote: (name) => `"${name.replaceAll('"', '""')}"`,
    named: (name, value) => `"${name.replaceAll('"', '""')}" => ${value}`,
    rejection: (reason) =>
      /(?:syntax error|no such function|wrong number of arguments|ambiguous column|no such column)/iu.test(reason)
        ? "binding"
        : "unclassified",
    kind: (row) => (row.kind === "w" ? "window" : "scalar"),
  }),

  versionBand: (version: string) => version.replace(/^reference-/u, ""),
  tokenize: tokenizeSqlite,
  planEntity: standardEntityProbe,
  planInvocations: (row) =>
    callProbeQueries(row, {
      kind: (row) =>
        row.kind === "p"
          ? "unavailable"
          : row.returns_set
            ? "table"
            : row.kind === "window" || row.kind === "w"
              ? "window"
              : "scalar",
      typedArgument: () => "NULL",
    }),
  createAnalysis(version, actualServer) {
    const base = { formatVersion: 1 as const, tables: {}, functions: {} };
    const actual = version.replace(/^reference-/u, "");
    const server = {
      product: "sqlite",
      version: actual,
      versionKey: actual,
      features: ["ENABLE_MATH_FUNCTIONS"],
      settings: {},
    };
    const grammar = sqlite();
    return {
      names: new Set(
        [...SQLITE_BUILTIN_FUNCTIONS.filter((row) => row.resolvable !== false), ...SQLITE_JSON_TABLE_FUNCTIONS]
          .filter(
            (row) => !row.availableSince || actual.localeCompare(row.availableSince, undefined, { numeric: true }) >= 0,
          )
          .map((row) => row.name.toLowerCase()),
      ),
      analyze: (sql: string) =>
        grammar.analyze(sql, { ...base, dialect: "sqlite", version: actual, server: actualServer ?? server }),
    };
  },
};
