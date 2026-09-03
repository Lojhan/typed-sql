import {
  defineGrammarConformanceFixture,
  GRAMMAR_CONFORMANCE_VERSION,
  type GrammarSemanticExpectation,
} from "@typed-sql/conformance";
import { type SyntheticSnapshot, type SyntheticTypePolicy, synthetic } from "./index.js";

export const syntheticSnapshot = {
  formatVersion: 1,
  dialect: "synthetic",
  dialectVersion: "1.0.0",
  version: "1.0.0",
  server: { product: "synthetic", version: "1.0.0", versionKey: "1", features: [], settings: {} },
  tables: {
    widgets: {
      name: "widgets",
      columns: {
        value: { name: "value", databaseType: "scalar", tsType: "number", nullable: false },
        label: { name: "label", databaseType: "text", tsType: "string", nullable: true },
      },
    },
  },
} as const satisfies SyntheticSnapshot;

const conservative: GrammarSemanticExpectation = {
  operation: "unknown",
  volatility: "unknown",
  locking: "unknown",
  connectionAffinity: "unknown",
  cardinalityMaximum: "unknown",
};

const analysis = (sql: string, row: string, parameters = "readonly []", resultKind: "rows" | "command" = "rows") => ({
  sql,
  parameterCount: parameters === "readonly []" ? 0 : 1,
  expectedRowType: row,
  expectedParameterType: parameters,
  expectedResultKind: resultKind,
  expectedSemantics: conservative,
});

const dialect = synthetic();

export const syntheticConformanceFixture = defineGrammarConformanceFixture<SyntheticSnapshot, SyntheticTypePolicy>({
  version: GRAMMAR_CONFORMANCE_VERSION,
  name: "synthetic-example",
  dialect,
  renderer: dialect,
  snapshot: syntheticSnapshot,
  placeholderTwo: "?2",
  identifier: "account]status",
  quotedIdentifier: "[account]]status]",
  probes: {
    select: analysis("SELECT value FROM widgets", '{ "value": number; }'),
    parameters: analysis("SELECT value FROM widgets WHERE value = ?1", '{ "value": number; }', "readonly [number]"),
    nullability: analysis("SELECT label FROM widgets", '{ "label": string | null; }'),
    joins: analysis(
      "SELECT widget.value, labels.label FROM widgets widget JOIN labels",
      '{ "value": number; "label": string | null; }',
    ),
    ctes: analysis("WITH selected AS (SELECT value FROM widgets) SELECT value FROM selected", '{ "value": number; }'),
    functions: analysis("SELECT synthetic_count() AS total", '{ "total": number; }'),
    dml: analysis("UPDATE widgets SET value = ?1", "{  }", "readonly [number]", "command"),
  },
  capabilities: [
    {
      capability: "returning",
      supported: false,
      unsupported: { sql: "UPDATE widgets SET value = ?1 RETURNING value", diagnosticCode: "SYN001" },
    },
  ],
  unsupported: { sql: "UNSUPPORTED `quoted` $" + "{value}", diagnosticCode: "SYN001" },
  structural: {
    source: [
      'import { sql } from "@typed-sql/example-synthetic-grammar";',
      "interface Selection { readonly label: boolean }",
      "export function widgets<const Select extends Selection>(select: Select) {",
      "  return sql`SELECT value$" + "{select.label ? sql.fragment`, label` : sql.empty} FROM widgets`;",
      "}",
    ].join("\n"),
    expectedVariantCount: 2,
    expectedRowType:
      'Select["label"] extends true ? { "value": number; "label": string | null; } : Select["label"] extends false ? { "value": number; } : { "value": number; "label": string | null; } | { "value": number; }',
    expectedParameterType: "readonly []",
    expectedSemantics: conservative,
  },
  policy: {
    sql: "SELECT value FROM widgets WHERE value = ?1",
    policy: { scalar: "string" },
    parameterCount: 1,
    expectedRowType: '{ "value": string; }',
    expectedParameterType: "readonly [string]",
  },
});
