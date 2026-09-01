import { defineSqlLexicalProfile, SqlToolkitError, tokenizeSql } from "@typed-sql/ast/toolkit";
import {
  assertDialectPlugin,
  DIALECT_CONTRACT_VERSION,
  type DialectAnalysis,
  type DialectPlugin,
  defineDialectCapabilityStates,
  type SchemaSnapshot,
  type SourceRange,
  sql,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { parseSchemaSnapshot } from "@typed-sql/schema";

export { sql };

export interface SyntheticTypePolicy {
  readonly scalar: "number" | "string";
}

export const typePolicy: SyntheticTypePolicy = Object.freeze({ scalar: "number" });
export const SYNTHETIC_GRAMMAR_VERSION = "1.0.0";
export type SyntheticSnapshot = SchemaSnapshot & { readonly dialect: "synthetic" };

const capabilities = Object.freeze({ returning: false });

const lexicalProfile = defineSqlLexicalProfile({
  keywords: new Set(["AS", "FROM", "JOIN", "SELECT", "SET", "UPDATE", "WHERE", "WITH"]),
  operators: ["=", "*"],
  identifierQuotes: [{ open: "[", close: "]", escape: "double-close" }],
  stringModes: [{ prefix: "", quote: "'" }],
  parameterModes: [{ kind: "numbered-question", startAt: 1 }],
});

function resolveCapabilities(snapshot: SyntheticSnapshot) {
  return defineDialectCapabilityStates(
    {
      returning: {
        level: "unsupported",
        reason: "The synthetic grammar deliberately omits RETURNING.",
        diagnostic: "SYN001",
        evidence: [
          { kind: "grammar", key: "grammarVersion", value: SYNTHETIC_GRAMMAR_VERSION },
          ...(snapshot.server === undefined
            ? []
            : [{ kind: "server-version" as const, key: snapshot.server.product, value: snapshot.server.versionKey }]),
        ],
      },
    },
    Object.keys(capabilities),
  );
}

function range(sqlText: string): SourceRange {
  return { start: 0, end: sqlText.length, line: 1, column: 1 };
}

function column(sqlText: string, name: string, tsType: string, nullable: boolean) {
  return { name, tsType, nullable, databaseType: name === "value" ? "scalar" : "text", range: range(sqlText) };
}

function supported(sqlText: string, policy: SyntheticTypePolicy): DialectAnalysis | undefined {
  const semantics = unknownQuerySemantics(range(sqlText), "The synthetic example deliberately stays conservative.");
  if (sqlText === "SELECT value FROM widgets") {
    return { columns: [column(sqlText, "value", policy.scalar, false)], parameters: [], diagnostics: [], semantics };
  }
  if (sqlText === "SELECT value FROM widgets WHERE value = ?1") {
    return {
      columns: [column(sqlText, "value", policy.scalar, false)],
      parameters: [{ index: 1, tsType: policy.scalar, nullable: false, databaseType: "scalar" }],
      diagnostics: [],
      semantics,
    };
  }
  if (sqlText === "SELECT label FROM widgets") {
    return { columns: [column(sqlText, "label", "string", true)], parameters: [], diagnostics: [], semantics };
  }
  if (sqlText === "SELECT value, label FROM widgets") {
    return {
      columns: [column(sqlText, "value", policy.scalar, false), column(sqlText, "label", "string", true)],
      parameters: [],
      diagnostics: [],
      semantics,
    };
  }
  if (sqlText === "SELECT widget.value, labels.label FROM widgets widget JOIN labels") {
    return {
      columns: [column(sqlText, "value", policy.scalar, false), column(sqlText, "label", "string", true)],
      parameters: [],
      diagnostics: [],
      semantics,
    };
  }
  if (sqlText === "WITH selected AS (SELECT value FROM widgets) SELECT value FROM selected") {
    return { columns: [column(sqlText, "value", policy.scalar, false)], parameters: [], diagnostics: [], semantics };
  }
  if (sqlText === "SELECT synthetic_count() AS total") {
    return { columns: [column(sqlText, "total", "number", false)], parameters: [], diagnostics: [], semantics };
  }
  if (sqlText === "UPDATE widgets SET value = ?1") {
    return {
      columns: [],
      parameters: [{ index: 1, tsType: policy.scalar, nullable: false, databaseType: "scalar" }],
      diagnostics: [],
      resultKind: "command",
      semantics,
    };
  }
  return undefined;
}

function analyze(sqlText: string, _snapshot: SyntheticSnapshot, policy: SyntheticTypePolicy): DialectAnalysis {
  try {
    tokenizeSql(sqlText, lexicalProfile, { maxDepth: 32, maxTokens: 2_000, maxSqlLength: 10_000 });
  } catch (error) {
    if (!(error instanceof SqlToolkitError)) throw error;
    const code = error.code === "TSQ002" ? error.code : "SYN001";
    return {
      columns: [],
      parameters: [],
      diagnostics: [{ code, message: error.message, severity: "error", range: error.range }],
      semantics: unknownQuerySemantics(error.range, "The synthetic grammar rejected malformed SQL."),
    };
  }
  const analysis = supported(sqlText, policy);
  if (analysis !== undefined) return analysis;
  return {
    columns: [],
    parameters: [],
    diagnostics: [
      {
        code: "SYN001",
        message: "The synthetic example does not support this statement",
        severity: "error",
        range: range(sqlText),
      },
    ],
    semantics: unknownQuerySemantics(range(sqlText), "The synthetic example does not support this statement."),
  };
}

function validateSnapshot(value: unknown): SyntheticSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "synthetic") throw new TypeError(`synthetic cannot use ${snapshot.dialect}`);
  if (snapshot.dialectVersion !== SYNTHETIC_GRAMMAR_VERSION) {
    throw new TypeError(`synthetic cannot use grammar ${String(snapshot.dialectVersion)}`);
  }
  return snapshot as SyntheticSnapshot;
}

const plugin = Object.freeze({
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "synthetic",
  grammarVersion: SYNTHETIC_GRAMMAR_VERSION,
  sqlModule: "@typed-sql/example-synthetic-grammar",
  capabilities,
  resolveCapabilities,
  defaultTypePolicy: typePolicy,
  placeholder(index: number) {
    if (!Number.isInteger(index) || index < 1) throw new RangeError("Synthetic parameters start at 1");
    return `?${index}`;
  },
  quoteIdentifier(identifier: string) {
    return `[${identifier.replaceAll("]", "]]")}]`;
  },
  analyze(sqlText: string, snapshot: SyntheticSnapshot, policy = typePolicy) {
    return analyze(sqlText, snapshot, policy);
  },
  validateSnapshot,
}) satisfies DialectPlugin<SyntheticSnapshot, SyntheticTypePolicy>;

assertDialectPlugin(plugin);

export function synthetic(): DialectPlugin<SyntheticSnapshot, SyntheticTypePolicy> {
  return plugin;
}
