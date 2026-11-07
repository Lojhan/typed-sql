import { sqlServerServerEvidence } from "../../../packages/sqlserver/src/capabilities.js";
import { SQLSERVER_BUILTINS } from "../../../packages/sqlserver/src/catalog/index.js";
import { sqlserver } from "../../../packages/sqlserver/src/index.js";
import { tokenize as tokenizeSqlServer } from "../../../packages/sqlserver/src/parser/tokenizer.js";
import { numericVersionBand } from "../../../tools/grammar-catalog/src/registry.mjs";
import { callProbeQueries } from "../invocations.js";
import type { AuditGrammar } from "./contracts.js";
import { sqlInvocationShapeSyntax } from "./shape-syntax.js";
import { standardEntityProbe } from "./sql-probes.js";

export const sqlserverAudit: AuditGrammar = {
  id: "sqlserver",
  invocationShapeSyntax: sqlInvocationShapeSyntax({
    quote: (name) => `[${name.replaceAll("]", "]]")}]`,
    named: (name, value) => {
      if (!/^@?[a-z_][a-z_0-9]*$/iu.test(name)) throw new TypeError("Unrenderable SQL Server parameter name");
      return `@${name.replace(/^@/u, "")} = ${value}`;
    },
    rejection: (reason) =>
      /(?:^|,)(?:[^:]*:)?(?:195|174|313|8144|102|156|201|137)(?=[:,]|$)/u.test(reason) ? "binding" : "unclassified",
    kind: () => "scalar",
  }),

  versionBand: numericVersionBand(1),
  tokenize: tokenizeSqlServer,
  planEntity: standardEntityProbe,
  planInvocations: (row) =>
    callProbeQueries(row, {
      kind: (row) =>
        ["IF", "TF", "FT"].includes(row.kind ?? "") || row.returns_set
          ? "table"
          : row.kind === "window" || row.kind === "w"
            ? "window"
            : "scalar",
      typedArgument: () => "NULL",
    }),
  createAnalysis(version, actualServer) {
    const base = { formatVersion: 1 as const, tables: {}, functions: {} };
    const major = Number.parseInt(version, 10);
    const server = sqlServerServerEvidence(`${major}.0.0.0`, {
      compatibilityLevel: major * 10,
      collation: "Latin1_General_100_CI_AS",
      defaultSchema: "dbo",
      quotedIdentifier: true,
      ansiWarnings: true,
      arithAbort: true,
      concatNullYieldsNull: true,
      dateFirst: 7,
      dateFormat: "mdy",
      language: "us_english",
    });
    const grammar = sqlserver();
    return {
      names: new Set(
        Object.values(SQLSERVER_BUILTINS)
          .filter((row) => !row.since || major >= row.since)
          .map((row) => row.name.toLowerCase()),
      ),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "sqlserver", server: actualServer ?? server }),
    };
  },
};
