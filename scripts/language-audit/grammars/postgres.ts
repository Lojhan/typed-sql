import { postgresServerEvidence } from "../../../packages/postgres/src/capabilities.js";
import { postgresCoreCatalog } from "../../../packages/postgres/src/catalog/index.js";
import { postgres } from "../../../packages/postgres/src/index.js";
import { tokenize as tokenizePostgres } from "../../../packages/postgres/src/parser/tokenizer.js";
import { numericVersionBand } from "../../../tools/grammar-catalog/src/registry.mjs";
import { callProbeQueries } from "../invocations.js";
import type { AuditGrammar } from "./contracts.js";
import { sqlInvocationShapeSyntax } from "./shape-syntax.js";
import { standardEntityProbe } from "./sql-probes.js";

export const postgresAudit: AuditGrammar = {
  id: "postgres",
  invocationShapeSyntax: sqlInvocationShapeSyntax({
    quote: (name) => `"${name.replaceAll('"', '""')}"`,
    named: (name, value) =>
      value.startsWith("VARIADIC ")
        ? `VARIADIC "${name.replaceAll('"', '""')}" => ${value.slice(9)}`
        : `"${name.replaceAll('"', '""')}" => ${value}`,
    kind: (row) =>
      row.kind === "p" || row.result_type_kind === "p"
        ? "unavailable"
        : row.returns_set
          ? "table"
          : row.kind === "w"
            ? "window"
            : "scalar",
    dynamicType: (name) => /^(?:any[a-z]*|record|internal|cstring|void|trigger|event_trigger)$/iu.test(name),
    rejection: (reason) =>
      /^(?:42883|42725|42601|42703|42P01|42804|42P18|42846):/u.test(reason)
        ? "binding"
        : /^22[A-Z0-9]{3}:/u.test(reason)
          ? "value"
          : "unclassified",
    variadicPrefix: "VARIADIC ",
  }),

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
