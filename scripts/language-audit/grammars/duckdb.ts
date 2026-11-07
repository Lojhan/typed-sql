import { duckDBBuiltinCatalog } from "../../../packages/duckdb/src/catalog/index.js";
import { duckdb } from "../../../packages/duckdb/src/index.js";
import { tokenize as tokenizeDuckDB } from "../../../packages/duckdb/src/parser/tokenizer.js";
import { duckDBServerEvidence } from "../../../packages/duckdb/src/support.js";
import { numericVersionBand } from "../../../tools/grammar-catalog/src/registry.mjs";
import { callProbeQueries } from "../invocations.js";
import type { AuditGrammar } from "./contracts.js";
import { standardEntityProbe } from "./sql-probes.js";

export const duckdbAudit: AuditGrammar = {
  id: "duckdb",
  versionBand: numericVersionBand(3),
  tokenize: tokenizeDuckDB,
  planEntity: standardEntityProbe,
  planInvocations: (row) =>
    callProbeQueries(row, {
      kind: (row) =>
        row.kind === "table" || row.kind === "table_macro" || row.returns_set
          ? "table"
          : row.kind === "window" || row.kind === "w"
            ? "window"
            : "scalar",
      typedArgument: (type, next) => (/\[\]$/u.test(type) ? "[0.5]" : `$${next()}`),
    }),
  createAnalysis(version, actualServer) {
    const base = { formatVersion: 1 as const, tables: {}, functions: {} };
    const grammar = duckdb();
    const server = duckDBServerEvidence(version, [], {
      Calendar: "gregorian",
      integer_division: "false",
      preserve_identifier_case: version === "1.5.6" ? "true" : "preserve_case",
      ...(version === "1.5.6" ? { old_implicit_casting: "false" } : {}),
    });
    return {
      names: new Set(duckDBBuiltinCatalog(version).map((row) => row[0].toLowerCase())),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "duckdb", server: actualServer ?? server }),
    };
  },
};
