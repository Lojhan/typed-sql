import {
  assertGrammarConformance,
  defineGrammarConformanceFixture,
  GRAMMAR_CONFORMANCE_VERSION,
  type GrammarAnalysisProbe,
  type GrammarSemanticExpectation,
} from "@typed-sql/conformance";
import { describe, it, strict } from "poku";
import { type SqliteSchemaSnapshot, sqlite } from "../src/index.js";

const snapshot = {
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  tables: {
    account: {
      schema: "main",
      name: "account",
      kind: "table",
      strict: true,
      withoutRowid: false,
      indexes: [],
      foreignKeys: [],
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
        score: { name: "score", databaseType: "REAL", tsType: "number", nullable: true },
      },
    },
  },
  functions: {
    "slug/1": {
      name: "slug",
      argumentTypes: ["TEXT"],
      databaseReturnType: "TEXT",
      returnType: "string",
      nullable: false,
      volatility: "immutable",
    },
  },
} as const satisfies SqliteSchemaSnapshot;

const stableMany: GrammarSemanticExpectation = {
  operation: "read",
  volatility: "stable",
  locking: "none",
  connectionAffinity: "none",
  cardinalityMaximum: "many",
};
const write: GrammarSemanticExpectation = {
  operation: "write",
  volatility: "volatile",
  locking: "none",
  connectionAffinity: "none",
  cardinalityMaximum: 0,
};

function probe(
  sql: string,
  expectedRowType: string,
  expectedParameterType = "readonly []",
  expectedSemantics: GrammarSemanticExpectation = stableMany,
  expectedResultKind: "rows" | "command" = "rows",
): GrammarAnalysisProbe {
  return {
    sql,
    parameterCount: expectedParameterType === "readonly []" ? 0 : 1,
    expectedRowType,
    expectedParameterType,
    expectedResultKind,
    expectedSemantics,
  };
}

const dialect = sqlite();
const fixture = defineGrammarConformanceFixture({
  version: GRAMMAR_CONFORMANCE_VERSION,
  name: "sqlite",
  dialect,
  renderer: dialect,
  snapshot,
  placeholderTwo: "?",
  identifier: 'account"status',
  quotedIdentifier: '"account""status"',
  probes: {
    select: probe("SELECT id, email FROM account", '{ "id": bigint; "email": string; }'),
    parameters: probe("SELECT id FROM account WHERE id = ?", '{ "id": bigint; }', "readonly [bigint]"),
    nullability: probe("SELECT score FROM account", '{ "score": number | null; }'),
    joins: probe(
      "SELECT left_account.id, right_account.score FROM account left_account LEFT JOIN account right_account ON left_account.id = right_account.id",
      '{ "id": bigint; "score": number | null; }',
    ),
    ctes: probe("WITH selected AS (SELECT id FROM account) SELECT id FROM selected", '{ "id": bigint; }'),
    functions: probe("SELECT slug(email) AS slug FROM account", '{ "slug": string; }'),
    dml: probe("UPDATE account SET email = ?", "{  }", "readonly [string]", write, "command"),
  },
  capabilities: [
    {
      capability: "aggregateFilter",
      supported: true,
      analysis: probe(
        "SELECT COUNT(*) FILTER (WHERE id > 0) AS total FROM account",
        '{ "total": bigint; }',
        "readonly []",
        { ...stableMany, capabilities: ["aggregateFilter"] },
      ),
    },
    {
      capability: "arrays",
      supported: false,
      unsupported: { sql: "SELECT DISTINCT ON (id) id FROM account", diagnosticCode: "TSQ401" },
    },
    {
      capability: "distinctOn",
      supported: false,
      unsupported: { sql: "SELECT DISTINCT ON (id) id FROM account", diagnosticCode: "TSQ401" },
    },
    {
      capability: "fullJoins",
      supported: true,
      analysis: probe(
        "SELECT left_account.id, right_account.score FROM account left_account FULL JOIN account right_account ON left_account.id = right_account.id",
        '{ "id": bigint | null; "score": number | null; }',
        "readonly []",
        { ...stableMany, capabilities: ["fullJoins"] },
      ),
    },
    {
      capability: "lockingReads",
      supported: false,
      unsupported: { sql: "SELECT id FROM account FOR UPDATE", diagnosticCode: "TSQ401" },
    },
    {
      capability: "recursiveCtes",
      supported: false,
      unsupported: {
        sql: "WITH RECURSIVE selected AS (SELECT id FROM account) SELECT id FROM selected",
        diagnosticCode: "TSQ401",
      },
    },
    {
      capability: "returning",
      supported: true,
      analysis: probe(
        "UPDATE account SET email = ? RETURNING id, email",
        '{ "id": bigint; "email": string; }',
        "readonly [string]",
        { ...write, cardinalityMaximum: "many", capabilities: ["returning"] },
      ),
    },
    {
      capability: "setOperations",
      supported: true,
      analysis: probe("SELECT id FROM account UNION ALL SELECT id FROM account", '{ "id": bigint; }', "readonly []", {
        ...stableMany,
        capabilities: ["setOperations"],
      }),
    },
    {
      capability: "strictTables",
      supported: true,
      analysis: probe("SELECT id FROM account", '{ "id": bigint; }'),
    },
  ],
  unsupported: { sql: "SELECT DISTINCT ON (id) id FROM account", diagnosticCode: "TSQ401" },
  structural: {
    source: [
      'import { sql } from "@typed-sql/sqlite";',
      "declare const includeScore: boolean;",
      "export const query = sql`SELECT id${includeScore ? sql.fragment`, score` : sql.empty} FROM account`;",
    ].join("\n"),
    expectedVariantCount: 2,
    expectedRowType: '{ "id": bigint; "score": number | null; } | { "id": bigint; }',
    expectedParameterType: "readonly []",
    expectedSemantics: stableMany,
  },
  policy: {
    sql: "SELECT COUNT(*) AS total",
    policy: { integer: "number", flexible: "union", unknown: "unknown" },
    parameterCount: 0,
    expectedRowType: '{ "total": number; }',
  },
});

await describe("SQLite public grammar conformance", async () => {
  await it("passes the public grammar contract", () => {
    const report = assertGrammarConformance(fixture);
    strict.strictEqual(report.grammar, "sqlite");
    strict.strictEqual(report.structuralVariants, 2);
  });
});
