import { mysql } from "../../../packages/mysql/src/analysis.js";
import { mySqlServerEvidence } from "../../../packages/mysql/src/capabilities.js";
import { mySqlCoreCatalog } from "../../../packages/mysql/src/catalog/index.js";
import { tokenize as tokenizeMySql } from "../../../packages/mysql/src/parser/tokenizer.js";
import { numericVersionBand } from "../../../tools/grammar-catalog/src/registry.mjs";
import { callProbeQueries } from "../invocations.js";
import type { AuditGrammar } from "./contracts.js";
import { sqlInvocationShapeSyntax } from "./shape-syntax.js";
import { standardEntityProbe } from "./sql-probes.js";

export const mysqlAudit: AuditGrammar = {
  id: "mysql",
  invocationShapeSyntax: sqlInvocationShapeSyntax({
    quote: (name) => `\`${name.replaceAll("`", "``")}\``,
    named: (name, value) => `\`${name.replaceAll("`", "``")}\` => ${value}`,
    rejection: (reason) =>
      /ER_(?:PARSE_ERROR|WRONG_PARAMCOUNT_TO_NATIVE_FCT|SP_WRONG_NO_OF_ARGS)/u.test(reason)
        ? "binding"
        : "unclassified",
    kind: () => "scalar",
  }),

  versionBand: numericVersionBand(2),
  tokenize: tokenizeMySql,
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
    const catalog = mySqlCoreCatalog(version);
    if (!catalog) throw new Error(`Unsupported MySQL catalog ${version}`);
    const server = mySqlServerEvidence(`${version}.0`, { versionComment: "MySQL Community Server - GPL", sqlMode: "" });
    const grammar = mysql({ versionPolicy: version === "26.7" ? "canary" : "stable" });
    return {
      names: new Set(catalog.routines.flatMap((family) => family.routines.map((name) => name.toLowerCase()))),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "mysql", server: actualServer ?? server }),
    };
  },
};
