import { postgresServerEvidence } from "../../../packages/postgres/src/capabilities.js";
import { postgresCoreCatalog } from "../../../packages/postgres/src/catalog/index.js";
import { postgres } from "../../../packages/postgres/src/index.js";
import { tokenize as tokenizePostgres } from "../../../packages/postgres/src/parser/tokenizer.js";
import { numericVersionBand } from "../../../tools/grammar-catalog/src/registry.mjs";
import { callProbeQueries } from "../invocations.js";
import type { AuditGrammar } from "./contracts.js";
import { standardEntityProbe } from "./sql-probes.js";

export const postgresAudit: AuditGrammar = {
  id: "postgres",
  versionBand: numericVersionBand(1),
  tokenize: tokenizePostgres,
  planEntity: standardEntityProbe,
  planInvocations: (row) =>
    callProbeQueries(row, {
      kind: (row) =>
        row.kind === "p" || row.result_type_kind === "p"
          ? "unavailable"
          : row.returns_set
            ? "table"
            : row.kind === "w" || row.kind === "window"
              ? "window"
              : "scalar",
      typedArgument: (type) => (/\[\]$/u.test(type) ? "ARRAY[]" : "NULL"),
      inferredArguments: (count) => Array.from({ length: count }, (_value, index) => `$${index + 1}`),
    }),
  createAnalysis(version, actualServer) {
    const base = { formatVersion: 1 as const, tables: {}, functions: {} };
    const major = Number.parseInt(version, 10);
    const server = postgresServerEvidence(`${major}.0`, [], { standardConformingStrings: "on", searchPath: "public" });
    const grammar = postgres({ versionPolicy: major === 19 ? "canary" : "stable" });
    const catalog = postgresCoreCatalog(major);
    if (!catalog) throw new Error(`Unsupported PostgreSQL catalog ${version}`);
    return {
      names: new Set(
        [...catalog.routines, ...catalog.tableRoutines].flatMap((family) =>
          family.routines.map((name) => name.toLowerCase()),
        ),
      ),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "postgres", server: actualServer ?? server }),
    };
  },
};
