import { describe, it } from "poku";
import {
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  type SchemaSnapshot,
  type SqlDiagnostic,
  unknownQuerySemantics,
} from "../../packages/core/src/index.js";
import { mysql, typePolicy as mysqlTypePolicy } from "../../packages/mysql/src/index.js";
import { mysqlRenderer } from "../../packages/mysql/src/runtime.js";
import { postgres, typePolicy as postgresTypePolicy } from "../../packages/postgres/src/index.js";
import { postgresRenderer } from "../../packages/postgres/src/runtime.js";
import { parseSchemaSnapshot } from "../../packages/schema/src/index.js";
import { assertDialectConformance } from "../grammar/conformance.js";

const range = { start: 0, end: 1, line: 1, column: 1 } as const;
const capabilities = {
  aggregateFilter: false,
  arrays: false,
  distinctOn: false,
  fullJoins: false,
  recursiveCtes: false,
  returning: false,
  setOperations: false,
} as const;

const postgresSnapshot = {
  formatVersion: 1,
  dialect: "postgres",
  dialectVersion: "1.0.0",
  tables: {
    widgets: {
      name: "widgets",
      columns: { value: { name: "value", databaseType: "bigint", tsType: "bigint", nullable: false } },
    },
  },
} as const;

const mysqlSnapshot = {
  ...postgresSnapshot,
  dialect: "mysql",
} as const;

interface SyntheticPolicy {
  readonly scalar: "number" | "string";
}

const syntheticTypePolicy: SyntheticPolicy = Object.freeze({ scalar: "number" });

const syntheticSnapshot = {
  formatVersion: 1,
  dialect: "synthetic",
  dialectVersion: "1.0.0",
  tables: {
    widgets: {
      name: "widgets",
      columns: { value: { name: "value", databaseType: "scalar", tsType: "number", nullable: false } },
    },
  },
} as const satisfies SchemaSnapshot;

function validateSynthetic(value: unknown): typeof syntheticSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "synthetic") throw new TypeError(`synthetic cannot use ${snapshot.dialect}`);
  if (snapshot.dialectVersion !== "1.0.0") throw new TypeError(`synthetic cannot use ${snapshot.dialectVersion}`);
  return snapshot as typeof syntheticSnapshot;
}

const synthetic: DialectPlugin<typeof syntheticSnapshot, SyntheticPolicy> = Object.freeze({
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "synthetic",
  grammarVersion: "1.0.0",
  sqlModule: "@acme/typed-sql-synthetic",
  capabilities,
  defaultTypePolicy: syntheticTypePolicy,
  placeholder(index: number): string {
    if (!Number.isInteger(index) || index < 1) throw new RangeError("synthetic parameters start at 1");
    return `?${index}`;
  },
  quoteIdentifier(identifier: string): string {
    return `[${identifier.replaceAll("]", "]]")}]`;
  },
  analyze(sql: string, _snapshot: typeof syntheticSnapshot, policy: SyntheticPolicy = syntheticTypePolicy) {
    if (sql === "SELECT value FROM widgets WHERE value = ?1") {
      return {
        columns: [{ name: "value", tsType: policy.scalar, nullable: false, databaseType: "scalar", range }],
        parameters: [{ index: 1, tsType: policy.scalar, nullable: false, databaseType: "scalar" }],
        diagnostics: [],
        semantics: unknownQuerySemantics({ ...range, end: sql.length }, "Synthetic test grammar"),
      };
    }
    const diagnostic: SqlDiagnostic = {
      code: "SYN001",
      message: "Synthetic grammar does not support this statement",
      severity: "error",
      range: { ...range, end: sql.length },
    };
    return {
      columns: [],
      parameters: [],
      diagnostics: [diagnostic],
      semantics: unknownQuerySemantics({ ...range, end: sql.length }, "Synthetic test grammar"),
    };
  },
  validateSnapshot: validateSynthetic,
});

const syntheticRenderer = {
  placeholder: (index: number) => synthetic.placeholder(index),
  quoteIdentifier: (identifier: string) => synthetic.quoteIdentifier(identifier),
};

await describe("public dialect-plugin conformance", async () => {
  await it("holds PostgreSQL to the public grammar contract", () => {
    assertDialectConformance({
      name: "postgres",
      dialect: postgres(),
      renderer: postgresRenderer,
      snapshot: postgresSnapshot,
      placeholderTwo: "$2",
      identifier: 'account"status',
      quotedIdentifier: '"account""status"',
      expectedCapabilities: {
        ...capabilities,
        aggregateFilter: true,
        arrays: true,
        distinctOn: true,
        fullJoins: true,
        recursiveCtes: true,
        returning: true,
      },
      query: "SELECT value FROM widgets WHERE value = $1",
      expectedRowType: '{ "value": bigint; }',
      expectedParameterType: "readonly [bigint]",
      unsupportedQuery: "SELECT value FROM widgets UNION SELECT value FROM widgets",
      unsupportedCode: "TSQ001",
      expectedSemantics: { operation: "read", volatility: "stable", cardinalityMaximum: "many" },
      policyProbe: {
        query: "SELECT CAST(1 AS bigint) AS value",
        policy: { ...postgresTypePolicy, bigint: "string" },
        expectedRowType: '{ "value": string; }',
      },
    });
  });

  await it("holds MySQL to the same public grammar contract", () => {
    assertDialectConformance({
      name: "mysql",
      dialect: mysql(),
      renderer: mysqlRenderer,
      snapshot: mysqlSnapshot,
      placeholderTwo: "?",
      identifier: "account`status",
      quotedIdentifier: "`account``status`",
      expectedCapabilities: capabilities,
      query: "SELECT value FROM widgets WHERE value = ?",
      expectedRowType: '{ "value": bigint; }',
      expectedParameterType: "readonly [bigint]",
      unsupportedQuery: "SELECT * FROM widgets FULL JOIN widgets AS other ON widgets.value = other.value",
      unsupportedCode: "TSQ401",
      expectedSemantics: { operation: "read", volatility: "stable", cardinalityMaximum: "many" },
      policyProbe: {
        query: "SELECT CAST(1 AS DECIMAL) AS value",
        policy: { ...mysqlTypePolicy, decimal: "number" },
        expectedRowType: '{ "value": number; }',
      },
    });
  });

  await it("accepts a synthetic third-party grammar with no internal imports", () => {
    assertDialectConformance({
      name: "synthetic",
      dialect: synthetic,
      renderer: syntheticRenderer,
      snapshot: syntheticSnapshot,
      placeholderTwo: "?2",
      identifier: "account]status",
      quotedIdentifier: "[account]]status]",
      expectedCapabilities: capabilities,
      query: "SELECT value FROM widgets WHERE value = ?1",
      expectedRowType: '{ "value": number; }',
      expectedParameterType: "readonly [number]",
      unsupportedQuery: "UNSUPPORTED",
      unsupportedCode: "SYN001",
      expectedSemantics: { operation: "unknown", volatility: "unknown", cardinalityMaximum: "unknown" },
      policyProbe: {
        query: "SELECT value FROM widgets WHERE value = ?1",
        policy: { scalar: "string" },
        expectedRowType: '{ "value": string; }',
      },
    });
  });
});
