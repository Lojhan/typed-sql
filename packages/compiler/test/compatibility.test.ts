import { describe, it, strict } from "poku";
import type { DialectPlugin, SchemaSnapshot } from "../../core/src/index.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import {
  analyzeSchemaCompatibility,
  buildQueryManifest,
  parseSchemaCompatibilityReport,
  serializeSchemaCompatibilityReport,
} from "../src/index.js";

const beforeSource = (module: string) =>
  [
    `import { sql } from ${JSON.stringify(module)};`,
    "declare const id: bigint;",
    "const account = sql`SELECT account.id, account.email FROM users AS account WHERE account.id = ${id}`;",
    'const dynamic = sql.dynamic("SELECT runtime");',
    "void [account, dynamic];",
  ].join("\n");

const afterSource = (module: string) =>
  [
    `import { sql } from ${JSON.stringify(module)};`,
    "declare const id: string;",
    "const account = sql`SELECT account.id, account.tenant_id FROM users AS account WHERE account.id = ${id}`;",
    'const dynamic = sql.dynamic("SELECT runtime");',
    "void [account, dynamic];",
  ].join("\n");

function snapshots(dialect: "postgres" | "mysql") {
  const schema = dialect === "postgres" ? "public" : "app";
  const tableKey = dialect === "postgres" ? "public.users" : "users";
  const before: SchemaSnapshot = {
    formatVersion: 1,
    dialect,
    version: dialect === "postgres" ? "17.8" : "8.0.40",
    tables: {
      [tableKey]: {
        schema,
        name: "users",
        columns: {
          id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
          email: {
            name: "email",
            databaseType: dialect === "postgres" ? "text" : "varchar(255)",
            tsType: "string",
            nullable: false,
            defaultExpression: "'recognizable-secret'",
          },
          nickname: { name: "nickname", databaseType: "text", tsType: "string", nullable: true },
          short_label: { name: "short_label", databaseType: "varchar(20)", tsType: "string", nullable: false },
          quantity: { name: "quantity", databaseType: "bigint", tsType: "bigint", nullable: false },
          status: {
            name: "status",
            databaseType: "enum('active','suspended')",
            tsType: '"active" | "suspended"',
            nullable: false,
          },
          display_name: { name: "display_name", databaseType: "text", tsType: "string", nullable: false },
        },
      },
    },
  };
  const after: SchemaSnapshot = {
    formatVersion: 1,
    dialect,
    version: dialect === "postgres" ? "18.4" : "8.4.11",
    tables: {
      [tableKey]: {
        schema,
        name: "users",
        columns: {
          id: {
            name: "id",
            databaseType: dialect === "postgres" ? "numeric" : "decimal",
            tsType: "string",
            nullable: false,
          },
          tenant_id: { name: "tenant_id", databaseType: "bigint", tsType: "bigint", nullable: false },
          nickname: {
            name: "nickname",
            databaseType: "text",
            tsType: "string",
            nullable: false,
            defaultExpression: "'anonymous'",
          },
          short_label: { name: "short_label", databaseType: "varchar(100)", tsType: "string", nullable: false },
          quantity: { name: "quantity", databaseType: "integer", tsType: "number", nullable: false },
          status: {
            name: "status",
            databaseType: "enum('active','suspended','deleted')",
            tsType: '"active" | "suspended" | "deleted"',
            nullable: false,
          },
          full_name: { name: "full_name", databaseType: "text", tsType: "string", nullable: false },
        },
      },
    },
  };
  return { before, after };
}

function manifest(dialect: DialectPlugin, snapshot: SchemaSnapshot, source: string) {
  return buildQueryManifest({
    rootDir: "/portable/project",
    sources: [{ file: "/portable/project/src/query.ts", source }],
    projects: ["/portable/project/tsconfig.json"],
    dialect,
    schema: snapshot,
    compilerVersion: "2.0.0-test",
  }).manifest;
}

await describe("schema migration compatibility", async () => {
  for (const [name, dialect] of [
    ["PostgreSQL", postgres()],
    ["MySQL", mysql()],
  ] as const) {
    await it(`classifies both rolling-deployment directions for ${name}`, () => {
      const value = snapshots(dialect.id as "postgres" | "mysql");
      const beforeManifest = manifest(dialect, value.before, beforeSource(dialect.sqlModule));
      const afterManifest = manifest(dialect, value.after, afterSource(dialect.sqlModule));
      const report = analyzeSchemaCompatibility({ ...value, beforeManifest, afterManifest });

      strict.ok(report.changes.some((item) => item.kind === "column-removed" && item.target.name === "email"));
      strict.ok(report.changes.some((item) => item.kind === "column-added" && item.target.name === "tenant_id"));
      strict.ok(report.changes.some((item) => item.kind === "column-database-type" && item.target.name === "id"));
      for (const kind of [
        "column-added",
        "column-removed",
        "column-database-type",
        "column-typescript-type",
        "column-nullability",
        "column-default",
      ] as const) {
        strict.ok(
          report.changes.some((item) => item.kind === kind),
          `${name} fixture does not cover ${kind}`,
        );
      }
      strict.ok(
        report.changes.some((item) => item.kind === "column-removed" && item.target.name === "display_name") &&
          report.changes.some((item) => item.kind === "column-added" && item.target.name === "full_name"),
        `${name} rename fixture must remain a conservative remove/add pair`,
      );
      strict.ok(report.changes.some((item) => item.kind === "server-version"));
      strict.ok(
        report.assessments.some(
          (item) =>
            item.direction === "before-app-after-database" &&
            item.classification === "runtime-breaking" &&
            item.queries.length > 0,
        ),
      );
      strict.ok(
        report.assessments.some(
          (item) =>
            item.direction === "after-app-before-database" &&
            item.classification === "runtime-breaking" &&
            item.queries.length > 0,
        ),
      );
      strict.ok(report.assessments.some((item) => item.classification === "unknown"));
      strict.ok(report.summary.error > 0);

      const serialized = serializeSchemaCompatibilityReport(report);
      strict.strictEqual(serialized, serializeSchemaCompatibilityReport(report));
      strict.ok(!serialized.includes("recognizable-secret"));
      strict.ok(!serialized.includes("/portable/project"));
      strict.strictEqual(parseSchemaCompatibilityReport(JSON.parse(serialized)).dialect, dialect.id);
    });
  }

  await it("fails closed for stale or cross-dialect manifests", () => {
    const value = snapshots("postgres");
    const pg = postgres();
    const beforeManifest = manifest(pg, value.before, beforeSource(pg.sqlModule));
    const afterManifest = manifest(pg, value.after, afterSource(pg.sqlModule));
    strict.throws(
      () =>
        analyzeSchemaCompatibility({
          ...value,
          beforeManifest: { ...beforeManifest, schemaHash: "0".repeat(64) },
          afterManifest,
        }),
      /stale/u,
    );
    strict.throws(
      () =>
        analyzeSchemaCompatibility({
          ...value,
          beforeManifest,
          afterManifest: { ...afterManifest, dialect: { ...afterManifest.dialect, id: "mysql" } },
        }),
      /same dialect/u,
    );
    strict.throws(
      () =>
        analyzeSchemaCompatibility({
          ...value,
          beforeManifest: {
            ...beforeManifest,
            queries: beforeManifest.queries.map((entry, index) =>
              index === 0 ? { ...entry, source: { ...entry.source, file: "/secret/query.ts" } } : entry,
            ),
          },
          afterManifest,
        }),
      /relative file/u,
    );
    strict.throws(() => parseSchemaCompatibilityReport({ formatVersion: 99 }), /Unsupported/u);
  });

  await it("fails closed when a resolved variant contains unsupported semantic facts", () => {
    const value = snapshots("postgres");
    const dialect = postgres();
    const source = beforeSource(dialect.sqlModule).replace('const dynamic = sql.dynamic("SELECT runtime");', "");
    const base = manifest(dialect, value.before, source);
    const unknown = {
      ...base,
      queries: base.queries.map((entry) =>
        entry.status === "unresolved"
          ? entry
          : {
              ...entry,
              variants: entry.variants.map((variant) => ({
                ...variant,
                semantics: {
                  ...variant.semantics,
                  operation: { ...variant.semantics.operation, value: "unknown" as const },
                },
              })),
            },
      ),
    };
    const report = analyzeSchemaCompatibility({
      before: value.before,
      after: value.before,
      beforeManifest: unknown,
      afterManifest: unknown,
    });
    strict.strictEqual(report.changes.length, 0);
    strict.strictEqual(report.summary.warning, 2);
    strict.ok(report.assessments.every((item) => item.classification === "unknown"));
  });

  await it("classifies the complete versioned snapshot change matrix without requiring application queries", () => {
    const before: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      dialectVersion: "1",
      tables: {
        removed_table: { name: "removed_table", columns: {} },
        users: {
          name: "users",
          columns: {
            removed_optional: { name: "removed_optional", databaseType: "text", tsType: "string", nullable: true },
            removed_required: { name: "removed_required", databaseType: "text", tsType: "string", nullable: false },
            changed: {
              name: "changed",
              databaseType: "text",
              tsType: "string",
              nullable: false,
              defaultExpression: "'before-secret'",
            },
          },
        },
      },
      enums: { removed_enum: ["old"], shared_enum: ["a", "b"] },
      domains: {
        removed_domain: { name: "removed_domain", databaseType: "text", tsType: "string", nullable: true },
        shared_domain: { name: "shared_domain", databaseType: "text", tsType: "string", nullable: true },
      },
      functions: {
        "removed_fn()": { name: "removed_fn", argumentTypes: [], returnType: "string", nullable: true },
        "shared_fn()": {
          name: "shared_fn",
          argumentTypes: [],
          databaseReturnType: "text",
          returnType: "string",
          nullable: true,
          volatility: "stable",
        },
      },
    };
    const after: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      dialectVersion: "2",
      tables: {
        added_table: { name: "added_table", columns: {} },
        users: {
          name: "users",
          columns: {
            added_optional: {
              name: "added_optional",
              databaseType: "text",
              tsType: "string",
              nullable: true,
              defaultExpression: "'safe'",
            },
            added_required: { name: "added_required", databaseType: "bigint", tsType: "bigint", nullable: false },
            changed: {
              name: "changed",
              databaseType: "bigint",
              tsType: "bigint",
              nullable: true,
              array: true,
              defaultExpression: "'after-secret'",
            },
          },
        },
      },
      enums: { added_enum: ["new"], shared_enum: ["b", "a", "c"] },
      domains: {
        added_domain: { name: "added_domain", databaseType: "text", tsType: "string", nullable: true },
        shared_domain: { name: "shared_domain", databaseType: "bigint", tsType: "bigint", nullable: false },
      },
      functions: {
        "added_fn(text)": {
          name: "added_fn",
          argumentTypes: ["text"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: true,
        },
        "shared_fn()": {
          name: "shared_fn",
          argumentTypes: [],
          databaseReturnType: "bigint",
          returnType: "bigint",
          nullable: false,
          setReturning: true,
          volatility: "volatile",
        },
      },
    };
    const dialect = postgres();
    const emptyManifest = (snapshot: SchemaSnapshot) => manifest(dialect, snapshot, "export {};\n");
    const report = analyzeSchemaCompatibility({
      before,
      after,
      beforeManifest: emptyManifest(before),
      afterManifest: emptyManifest(after),
    });
    const kinds = new Set(report.changes.map((item) => item.kind));
    for (const expected of [
      "relation-added",
      "relation-removed",
      "column-added",
      "column-removed",
      "column-database-type",
      "column-typescript-type",
      "column-nullability",
      "column-array",
      "column-default",
      "enum-added",
      "enum-removed",
      "enum-values",
      "domain-added",
      "domain-removed",
      "domain-database-type",
      "domain-typescript-type",
      "domain-nullability",
      "function-added",
      "function-removed",
      "function-return-type",
      "function-nullability",
      "function-set-returning",
      "function-volatility",
      "dialect-version",
    ] as const) {
      strict.ok(kinds.has(expected), `Missing ${expected}`);
    }
    strict.ok(report.assessments.every((item) => item.classification === "compatible"));
    const serialized = serializeSchemaCompatibilityReport(report);
    strict.ok(!serialized.includes("before-secret"));
    strict.ok(!serialized.includes("after-secret"));
  });

  await it("records source-breaking query contracts for unchanged SQL across snapshots", () => {
    const dialect = postgres();
    const before: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        users: {
          name: "users",
          columns: { id: { name: "id", databaseType: "text", tsType: "string", nullable: false } },
        },
      },
    };
    const after: SchemaSnapshot = {
      ...before,
      tables: {
        users: {
          name: "users",
          columns: { id: { name: "id", databaseType: "text", tsType: "bigint", nullable: false } },
        },
      },
    };
    const source = 'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT users.id FROM users`;';
    const report = analyzeSchemaCompatibility({
      before,
      after,
      beforeManifest: manifest(dialect, before, source),
      afterManifest: manifest(dialect, after, source),
    });
    strict.ok(report.changes.some((item) => item.kind === "query-contract"));
    strict.ok(report.assessments.some((item) => item.classification === "source-breaking"));
  });

  await it("resolves dependencies through declared column names instead of assuming map keys", () => {
    const dialect = postgres();
    const before: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        users: {
          name: "users",
          columns: { id_key: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false } },
        },
      },
    };
    const after: SchemaSnapshot = {
      ...before,
      tables: {
        users: {
          name: "users",
          columns: { id_key: { name: "id", databaseType: "numeric", tsType: "string", nullable: false } },
        },
      },
    };
    const source = 'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT users.id FROM users`;';
    const report = analyzeSchemaCompatibility({
      before,
      after,
      beforeManifest: manifest(dialect, before, source),
      afterManifest: manifest(dialect, after, source),
    });
    strict.ok(
      report.assessments.some(
        (item) => item.changeId !== undefined && item.classification === "runtime-breaking" && item.queries.length > 0,
      ),
    );
  });

  await it("detects default, mandatory-column, and overload hazards through write and function dependencies", () => {
    const dialect = postgres();
    const before: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
            legacy: { name: "legacy", databaseType: "text", tsType: "string", nullable: false },
            changing: {
              name: "changing",
              databaseType: "text",
              tsType: "string",
              nullable: false,
              defaultExpression: "'before'",
            },
          },
        },
      },
      functions: {
        "calculate(text)": {
          name: "calculate",
          argumentTypes: ["text"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: false,
          volatility: "stable",
        },
      },
    };
    const after: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
            tenant: { name: "tenant", databaseType: "bigint", tsType: "bigint", nullable: false },
            changing: {
              name: "changing",
              databaseType: "text",
              tsType: "string",
              nullable: false,
              defaultExpression: "'after'",
            },
          },
        },
      },
      functions: {
        "calculate(bigint)": {
          name: "calculate",
          argumentTypes: ["bigint"],
          databaseReturnType: "bigint",
          returnType: "bigint",
          nullable: false,
          volatility: "stable",
        },
      },
    };
    const beforeSql = [
      'import { sql } from "@typed-sql/postgres";',
      "declare const id: bigint; declare const legacy: string;",
      "const insert = sql`INSERT INTO users (id, legacy) VALUES (${id}, ${legacy})`;",
      "const call = sql`SELECT calculate(${legacy}) AS value`;",
      "void [insert, call];",
    ].join("\n");
    const afterSql = [
      'import { sql } from "@typed-sql/postgres";',
      "declare const id: bigint; declare const tenant: bigint;",
      "const insert = sql`INSERT INTO users (id, tenant) VALUES (${id}, ${tenant})`;",
      "const call = sql`SELECT calculate(${id}) AS value`;",
      "void [insert, call];",
    ].join("\n");
    const report = analyzeSchemaCompatibility({
      before,
      after,
      beforeManifest: manifest(dialect, before, beforeSql),
      afterManifest: manifest(dialect, after, afterSql),
    });
    strict.ok(
      report.assessments.some(
        (item) => item.classification === "deployment-order-sensitive" && item.severity === "warning",
      ),
    );
    strict.ok(
      report.assessments.some(
        (item) => item.classification === "deployment-order-sensitive" && item.severity === "error",
      ),
    );
    strict.ok(report.assessments.some((item) => item.classification === "runtime-breaking"));
  });

  await it("links enum and domain changes through explicit cast dependencies", () => {
    const dialect = postgres();
    const before: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "postgres",
      tables: {},
      enums: {
        "public.account_status": ["active", "suspended"],
        "tenant.account_status": ["active"],
      },
      domains: {
        "public.email_address": {
          name: "email_address",
          databaseType: "text",
          tsType: "string",
          nullable: false,
        },
        "tenant.email_address": {
          name: "email_address",
          databaseType: "text",
          tsType: "string",
          nullable: false,
        },
      },
    };
    const after: SchemaSnapshot = {
      ...before,
      enums: {
        "public.account_status": ["active", "suspended", "deleted"],
        "tenant.account_status": ["active"],
      },
      domains: {
        "public.email_address": {
          name: "email_address",
          databaseType: "varchar",
          tsType: "string",
          nullable: false,
        },
        "tenant.email_address": {
          name: "email_address",
          databaseType: "text",
          tsType: "string",
          nullable: false,
        },
      },
    };
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      "declare const value: string;",
      "const status = sql`SELECT CAST(${value} AS public.account_status) AS value`;",
      "const email = sql`SELECT CAST(${value} AS public.email_address) AS value`;",
      "void [status, email];",
    ].join("\n");
    const report = analyzeSchemaCompatibility({
      before,
      after,
      beforeManifest: manifest(dialect, before, source),
      afterManifest: manifest(dialect, after, source),
    });
    strict.ok(
      report.assessments.some(
        (item) => item.classification === "runtime-breaking" && item.queries.some((query) => query.dependencyRange),
      ),
    );
  });

  await it("validates report envelopes", () => {
    const artifact = { schemaHash: "0".repeat(64), manifestHash: `sha256:${"0".repeat(64)}` };
    const valid = {
      formatVersion: 1,
      analyzerVersion: "typed-sql-v1",
      dialect: "postgres",
      before: artifact,
      after: artifact,
      changes: [],
      assessments: [],
      summary: { info: 0, warning: 0, error: 0 },
    } as const;
    for (const [value, pattern] of [
      [null, /must be an object/u],
      [{ formatVersion: 1, analyzerVersion: "future" }, /analyzer/u],
      [{ ...valid, dialect: "" }, /dialect/u],
      [{ ...valid, before: { ...artifact, schemaHash: "invalid" } }, /schemaHash/u],
      [{ ...valid, summary: { info: "0", warning: 0, error: 0 } }, /summary/u],
    ] as const) {
      strict.throws(() => parseSchemaCompatibilityReport(value), pattern);
    }
    strict.strictEqual(parseSchemaCompatibilityReport(valid).dialect, "postgres");

    type MutableReport = {
      before: Record<string, unknown>;
      changes: Array<Record<string, unknown> & { target: Record<string, unknown> }>;
      assessments: Array<Record<string, unknown> & { queries: Array<Record<string, unknown>> }>;
    };
    const value = snapshots("postgres");
    const dialect = postgres();
    const complete = analyzeSchemaCompatibility({
      ...value,
      beforeManifest: manifest(dialect, value.before, beforeSource(dialect.sqlModule)),
      afterManifest: manifest(dialect, value.after, afterSource(dialect.sqlModule)),
    });
    const mutable = () => JSON.parse(serializeSchemaCompatibilityReport(complete)) as MutableReport;
    const expectInvalid = (mutate: (report: MutableReport) => void, pattern: RegExp) => {
      const report = mutable();
      mutate(report);
      strict.throws(() => parseSchemaCompatibilityReport(report), pattern);
    };
    const assessmentWithQuery = (report: MutableReport) => {
      const assessment = report.assessments.find((item) => item.queries.length > 0);
      if (assessment === undefined) throw new Error("Fixture must contain an affected query");
      return assessment;
    };
    expectInvalid((report) => {
      report.before.version = "";
    }, /version/u);
    expectInvalid((report) => {
      report.before.manifestHash = "invalid";
    }, /manifestHash/u);
    expectInvalid((report) => {
      (report as unknown as Record<string, unknown>).changes = null;
    }, /changes/u);
    expectInvalid((report) => {
      report.changes[0] = { target: {} };
    }, /change 0/u);
    expectInvalid((report) => {
      report.changes[0]!.target.kind = "invalid";
    }, /target.kind/u);
    expectInvalid((report) => {
      report.changes[0]!.target.key = "";
    }, /target.key/u);
    expectInvalid((report) => {
      report.changes[0]!.target.parent = 42;
    }, /target.parent/u);
    expectInvalid((report) => {
      report.changes[0]!.before = { unsupported: 42 };
    }, /evidence/u);
    expectInvalid((report) => {
      report.changes[0]!.id = `sha256:${"f".repeat(64)}`;
    }, /canonical evidence/u);
    expectInvalid((report) => {
      report.changes.push(structuredClone(report.changes[0]!));
    }, /duplicated/u);
    expectInvalid((report) => {
      report.assessments[0]!.direction = "sideways";
    }, /assessment 0/u);
    expectInvalid((report) => {
      (report as unknown as Record<string, unknown>).assessments = null;
    }, /assessments/u);
    expectInvalid((report) => {
      report.assessments[0]!.reason = "";
    }, /reason/u);
    expectInvalid((report) => {
      report.assessments[0]!.changeId = `sha256:${"f".repeat(64)}`;
    }, /identify/u);
    expectInvalid((report) => {
      const assessment = assessmentWithQuery(report);
      assessment.queries[0]!.source = { file: "/secret/query.ts", range: {} };
    }, /relative path/u);
    expectInvalid((report) => {
      const assessment = assessmentWithQuery(report);
      assessment.queries[0]!.queryId = "invalid";
    }, /queryId/u);
    expectInvalid((report) => {
      const assessment = assessmentWithQuery(report);
      assessment.queries[0]!.source = null;
    }, /source/u);
    expectInvalid((report) => {
      const assessment = assessmentWithQuery(report);
      const source = assessment.queries[0]!.source as { range: Record<string, unknown> };
      source.range.start = -1;
    }, /source range/u);
    expectInvalid((report) => {
      const assessment = report.assessments.find((item) =>
        item.queries.some((query) => query.dependencyRange !== undefined),
      );
      if (assessment === undefined) throw new Error("Fixture must contain a dependency range");
      const query = assessment.queries.find((item) => item.dependencyRange !== undefined);
      if (query === undefined) throw new Error("Fixture must contain a dependency range");
      query.dependencyRange = { start: 1, end: 0, line: 1, column: 1 };
    }, /dependencyRange/u);
    expectInvalid((report) => {
      (report as unknown as Record<string, unknown>).summary = null;
    }, /summary/u);
  });
});
