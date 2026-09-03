import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { type MySqlSchemaSnapshot, mysql, typePolicy as mysqlTypePolicy } from "../../mysql/src/index.js";
import { type PostgresSchemaSnapshot, postgres, typePolicy as postgresTypePolicy } from "../../postgres/src/index.js";
import type { SchemaSnapshot } from "../../schema/src/index.js";
import {
  buildQueryManifest,
  listProjectSourceFiles,
  parseQueryManifest,
  QUERY_MANIFEST_JSON_SCHEMA,
  serializeQueryManifest,
} from "../src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function snapshot(dialect: "mysql" | "postgres"): SchemaSnapshot {
  return {
    formatVersion: 1,
    dialect,
    tables: {
      users: {
        name: "users",
        columns: {
          id: {
            name: "id",
            databaseType: dialect === "postgres" ? "bigint" : "bigint",
            tsType: "bigint",
            nullable: false,
          },
          email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
          status: { name: "status", databaseType: "text", tsType: '"active" | "suspended"', nullable: false },
        },
      },
    },
  };
}

const source = [
  'import { sql } from "@typed-sql/postgres";',
  "declare const minimum: bigint;",
  'const query = sql`SELECT users.id, users.email ${process.env["recognizable-secret"] ? sql.fragment`, users.status` : sql.empty} FROM users WHERE users.id >= ${minimum}`;',
  "const invalid = sql`SELECT missing FROM absent`;",
  'const runtime = sql.dynamic(process.env.RUNTIME_SQL ?? "SELECT 1");',
  "void [query, invalid, runtime];",
].join("\n");

await describe("deterministic query manifests", async () => {
  await it("emits resolved structural variants and explicit unresolved entries without source values", () => {
    const root = "/checkout/typed-sql-app";
    const policy = {
      ...postgresTypePolicy,
      connectionString: "postgresql://user:recognizable-secret@localhost/db",
    };
    const result = buildQueryManifest({
      rootDir: root,
      sources: [{ file: join(root, "src", "accounts.ts"), source }],
      projects: [join(root, "tsconfig.json")],
      dialect: postgres(),
      schema: snapshot("postgres") as PostgresSchemaSnapshot,
      typePolicy: policy,
      compilerVersion: "2.0.0-test",
    });
    strict.strictEqual(result.stats.resolvedQueries, 1);
    strict.strictEqual(result.stats.unresolvedQueries, 2);
    const resolved = result.manifest.queries.find((query) => query.status === "resolved");
    strict.strictEqual(resolved?.structural, true);
    strict.strictEqual(resolved?.variants.length, 2);
    strict.deepStrictEqual(
      resolved?.variants.map((variant) => variant.parameters.length),
      [1, 1],
    );
    strict.ok(resolved?.variants.some((variant) => variant.columns.some((column) => column.name === "status")));
    strict.ok(
      resolved?.variants.every((variant) =>
        Object.keys(variant.choices).every((choice) => choice.startsWith("sha256:")),
      ),
    );
    strict.ok(resolved?.semantics.dependencies.some((dependency) => dependency.name === "users"));
    strict.deepStrictEqual(
      result.manifest.queries.filter((query) => query.status === "unresolved").map((query) => query.reason),
      ["diagnostic", "dynamic"],
    );
    const serialized = serializeQueryManifest(result.manifest);
    strict.ok(!serialized.includes("recognizable-secret"));
    strict.ok(!serialized.includes(root));
    strict.ok(!serialized.includes("RUNTIME_SQL"));
    strict.match(result.manifest.dialect.capabilityFingerprint ?? "", /^[a-f\d]{64}$/u);
    strict.deepStrictEqual(parseQueryManifest(JSON.parse(serialized)), JSON.parse(serialized));
    strict.strictEqual(QUERY_MANIFEST_JSON_SCHEMA.properties.formatVersion.const, 1);
  });

  await it("is byte-identical across source order and absolute checkout roots", () => {
    const files = [
      { relative: "src/z.ts", source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT id FROM users`;' },
      { relative: "src/a.ts", source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT email FROM users`;' },
    ];
    const generate = (root: string, reversed: boolean) =>
      serializeQueryManifest(
        buildQueryManifest({
          rootDir: root,
          sources: (reversed ? [...files].reverse() : files).map((file) => ({
            file: join(root, file.relative),
            source: file.source,
          })),
          projects: [join(root, "tsconfig.json")],
          dialect: postgres(),
          schema: snapshot("postgres") as PostgresSchemaSnapshot,
          typePolicy: postgresTypePolicy,
          compilerVersion: "2.0.0-test",
        }).manifest,
      );
    strict.strictEqual(generate("/first/checkout", false), generate("/different/checkout", true));
  });

  await it("serializes cardinality-independent repeated-fragment artifacts", () => {
    const root = "/checkout/repeated";
    const mappedSource = [
      'import { sql } from "@typed-sql/postgres";',
      "declare const rows: readonly { readonly id: bigint; readonly email: string }[];",
      "sql`INSERT INTO users (id, email) VALUES ${rows.map((row) => sql.fragment`(${row.id}, ${row.email})`)}`;",
    ].join("\n");
    const result = buildQueryManifest({
      rootDir: root,
      sources: [{ file: join(root, "insert.ts"), source: mappedSource }],
      dialect: postgres(),
      schema: snapshot("postgres") as PostgresSchemaSnapshot,
      typePolicy: postgresTypePolicy,
      compilerVersion: "2.0.0-test",
    });
    const query = result.manifest.queries[0];
    if (query?.status !== "resolved") throw new Error("Expected a resolved repeated-fragment query");
    const artifact = query.repeatedFragments?.[0];
    strict.strictEqual(artifact?.kind, "repeated-fragment");
    strict.strictEqual(artifact?.minimumItems, 1);
    strict.strictEqual(artifact?.separator.text, ", ");
    strict.deepStrictEqual(
      artifact?.parameterPattern.map(({ index, tsType }) => ({ index, tsType })),
      [
        { index: 1, tsType: "bigint" },
        { index: 2, tsType: "string" },
      ],
    );
    strict.deepStrictEqual(parseQueryManifest(JSON.parse(serializeQueryManifest(result.manifest))), result.manifest);
  });

  await it("records canonical evidence only for capabilities a query depends on", () => {
    const root = "/checkout/capabilities";
    const result = buildQueryManifest({
      rootDir: root,
      sources: [
        {
          file: join(root, "delete.ts"),
          source: 'import { sql } from "@typed-sql/postgres"; sql`DELETE FROM users RETURNING id`;',
        },
      ],
      dialect: postgres(),
      schema: {
        ...(snapshot("postgres") as PostgresSchemaSnapshot),
        version: "18.6",
        server: {
          product: "postgres",
          version: "18.6",
          versionKey: "18",
          features: ["plpgsql:1.0"],
          settings: { standardConformingStrings: "on" },
        },
      },
      typePolicy: postgresTypePolicy,
      compilerVersion: "2.0.0-test",
    });
    const query = result.manifest.queries[0];
    if (query?.status !== "resolved") throw new Error("Expected a resolved capability query");
    strict.deepStrictEqual(
      query.capabilityEvidence?.map(({ capability }) => capability),
      ["returning"],
    );
    strict.strictEqual(query.capabilityEvidence?.[0]?.level, "exact");
    strict.ok(query.capabilityEvidence?.[0]?.evidence.some(({ kind }) => kind === "server-version"));
    strict.deepStrictEqual(
      query.variants[0]?.capabilityEvidence?.map(({ capability }) => capability),
      ["returning"],
    );
    strict.deepStrictEqual(parseQueryManifest(result.manifest), result.manifest);
  });

  await it("reuses unchanged source analysis and invalidates changed sources", () => {
    const root = "/checkout/app";
    const options = {
      rootDir: root,
      sources: [
        {
          file: join(root, "query.ts"),
          source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT id FROM users`;',
        },
      ],
      dialect: postgres(),
      schema: snapshot("postgres") as PostgresSchemaSnapshot,
      typePolicy: postgresTypePolicy,
      compilerVersion: "2.0.0-test",
    } as const;
    const initial = buildQueryManifest(options);
    const reused = buildQueryManifest({ ...options, previous: initial.manifest });
    strict.deepStrictEqual(reused.stats, {
      analyzedFiles: 0,
      reusedFiles: 1,
      resolvedQueries: 1,
      unresolvedQueries: 0,
    });
    strict.strictEqual(serializeQueryManifest(reused.manifest), serializeQueryManifest(initial.manifest));
    const changed = buildQueryManifest({
      ...options,
      sources: [{ ...options.sources[0], source: `${options.sources[0].source}\n// changed` }],
      previous: reused.manifest,
    });
    strict.strictEqual(changed.stats.analyzedFiles, 1);
    strict.strictEqual(changed.stats.reusedFiles, 0);
    const changedCapabilities = buildQueryManifest({
      ...options,
      schema: {
        ...options.schema,
        version: "18.6",
        server: {
          product: "postgres",
          version: "18.6",
          versionKey: "18",
          features: [],
          settings: { standardConformingStrings: "on" },
        },
      },
      previous: reused.manifest,
    });
    strict.strictEqual(changedCapabilities.stats.analyzedFiles, 1);
    strict.notStrictEqual(
      changedCapabilities.manifest.dialect.capabilityFingerprint,
      reused.manifest.dialect.capabilityFingerprint,
    );
  });

  await it("uses the same grammar-neutral manifest contract for MySQL", () => {
    const root = "/checkout/mysql-app";
    const result = buildQueryManifest({
      rootDir: root,
      sources: [
        {
          file: join(root, "query.ts"),
          source:
            'import { sql } from "@typed-sql/mysql"; declare const id: bigint; sql`SELECT email FROM users WHERE id = ${id}`;',
        },
      ],
      dialect: mysql(),
      schema: snapshot("mysql") as MySqlSchemaSnapshot,
      typePolicy: mysqlTypePolicy,
      compilerVersion: "2.0.0-test",
    });
    const query = result.manifest.queries[0];
    strict.strictEqual(query?.status, "resolved");
    if (query?.status !== "resolved") throw new Error("Expected a resolved MySQL query");
    strict.strictEqual(query.variants[0]?.parameters[0]?.tsType, "bigint");
    strict.strictEqual(query.variants[0]?.columns[0]?.name, "email");
    strict.ok(query.semantics.dependencies.some((dependency) => dependency.name === "users"));
    strict.strictEqual(result.manifest.dialect.id, "mysql");
  });

  await it("rejects incompatible manifest format versions", () => {
    strict.throws(() => parseQueryManifest({ formatVersion: 2 }), /Unsupported query manifest format 2/u);
    const root = "/checkout/validation";
    const valid = JSON.parse(
      serializeQueryManifest(
        buildQueryManifest({
          rootDir: root,
          sources: [
            {
              file: join(root, "query.ts"),
              source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT id FROM users`;',
            },
          ],
          dialect: postgres(),
          schema: snapshot("postgres") as PostgresSchemaSnapshot,
          compilerVersion: "validation",
        }).manifest,
      ),
    ) as Record<string, unknown>;
    const resolved = (valid.queries as Record<string, unknown>[])[0]!;
    const variant = (resolved.variants as Record<string, unknown>[])[0]!;
    const semantics = resolved.semantics as Record<string, unknown>;
    const sourceLocation = resolved.source as Record<string, unknown>;
    const sourceRange = sourceLocation.range as Record<string, unknown>;
    const columns = variant.columns as Record<string, unknown>[];
    const parameters = variant.parameters as Record<string, unknown>[];
    const capability = {
      capability: "returning",
      level: "exact",
      reason: "supported",
      evidence: [{ kind: "grammar", key: "grammarVersion", value: "1" }],
    };
    for (const invalid of [
      null,
      { ...valid, compilerVersion: 1 },
      { ...valid, compilerVersion: "" },
      { ...valid, fingerprintAlgorithm: "future" },
      { ...valid, dialect: null },
      { ...valid, dialect: { id: "", grammarVersion: "1" } },
      { ...valid, dialect: { id: "postgres", grammarVersion: "1", capabilityFingerprint: 1 } },
      { ...valid, dialect: { id: "postgres", grammarVersion: "1", capabilityFingerprint: "invalid" } },
      { ...valid, schemaFormat: 3 },
      { ...valid, schemaHash: 1 },
      { ...valid, typePolicyHash: "invalid" },
      { ...valid, queries: null },
      { ...valid, projects: ["/absolute/tsconfig.json"] },
      { ...valid, sources: [{ file: "/absolute/query.ts", hash: "x" }] },
      { ...valid, queries: [{ id: 1, source: null }] },
      {
        ...valid,
        queries: [{ ...resolved, source: { ...sourceLocation, range: { ...sourceRange, start: "zero" } } }],
      },
      { ...valid, queries: [{ ...resolved, source: { ...sourceLocation, range: { ...sourceRange, end: -1 } } }] },
      { ...valid, queries: [{ ...resolved, fingerprint: "invalid" }] },
      { ...valid, queries: [{ ...resolved, structural: "yes" }] },
      { ...valid, queries: [{ ...resolved, variants: [] }] },
      { ...valid, queries: [{ ...resolved, diagnostics: [{}] }] },
      { ...valid, queries: [{ ...resolved, variants: [{ ...variant, fingerprint: "invalid" }] }] },
      { ...valid, queries: [{ ...resolved, variants: [{ ...variant, choices: { rawCondition: true } }] }] },
      { ...valid, queries: [{ ...resolved, variants: [{ ...variant, columns: "invalid" }] }] },
      {
        ...valid,
        queries: [{ ...resolved, variants: [{ ...variant, columns: [{ ...columns[0], nullable: "yes" }] }] }],
      },
      {
        ...valid,
        queries: [{ ...resolved, variants: [{ ...variant, parameters: [{ ...parameters[0], index: 0 }] }] }],
      },
      {
        ...valid,
        queries: [{ ...resolved, variants: [{ ...variant, semantics: { ...semantics, version: 2 } }] }],
      },
      {
        ...valid,
        queries: [{ ...resolved, semantics: { ...semantics, capabilities: [1] } }],
      },
      {
        ...valid,
        queries: [{ ...resolved, capabilityEvidence: [{ capability: "returning", level: "exact" }] }],
      },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: {} }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [null] }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [{ ...capability, capability: "Returning" }] }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [{ ...capability, reason: "" }] }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [{ ...capability, since: 1 }] }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [{ ...capability, level: "future" }] }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [{ ...capability, evidence: [] }] }] },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [{ ...capability, evidence: [null] }] }] },
      {
        ...valid,
        queries: [
          {
            ...resolved,
            capabilityEvidence: [{ ...capability, evidence: [{ kind: "future", key: "grammarVersion", value: "1" }] }],
          },
        ],
      },
      {
        ...valid,
        queries: [
          {
            ...resolved,
            capabilityEvidence: [{ ...capability, evidence: [{ kind: "grammar", key: 1, value: "1" }] }],
          },
        ],
      },
      {
        ...valid,
        queries: [
          {
            ...resolved,
            capabilityEvidence: [{ ...capability, evidence: [{ kind: "grammar", key: "grammarVersion", value: 1 }] }],
          },
        ],
      },
      {
        ...valid,
        queries: [{ ...resolved, variants: [{ ...variant, capabilityEvidence: {} }] }],
      },
      { ...valid, queries: [{ ...resolved, capabilityEvidence: [capability, capability] }] },
      {
        ...valid,
        queries: [
          {
            ...resolved,
            status: "resolved",
            diagnostics: undefined,
          },
        ],
      },
      {
        ...valid,
        queries: [{ ...resolved, status: "unresolved", reason: "dynamic", diagnostics: [] }],
      },
      {
        ...valid,
        queries: [
          {
            ...resolved,
            status: "unresolved",
            reason: "other",
            diagnostics: [],
          },
        ],
      },
      {
        ...valid,
        queries: [
          {
            ...resolved,
            status: "future",
          },
        ],
      },
    ]) {
      strict.throws(() => parseQueryManifest(invalid));
    }
  });

  await it("enumerates application sources through the workspace TypeScript project", async () => {
    const directory = await mkdtemp(join(workspace, ".typed-sql-project-files-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(join(directory, "src", "query.ts"), "export const value = 1;\n");
      await writeFile(join(directory, "src", "types.d.ts"), "export declare const ignored: true;\n");
      await writeFile(
        join(directory, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] })}\n`,
      );
      strict.deepStrictEqual(await listProjectSourceFiles({ project: "tsconfig.json", cwd: directory }), [
        join(directory, "src", "query.ts"),
      ]);
      await strict.rejects(
        () => listProjectSourceFiles({ project: "missing.json", cwd: directory }),
        /Could not enumerate TypeScript project/u,
      );
      await strict.rejects(
        () => listProjectSourceFiles({ project: "tsconfig.json", cwd: directory, typeScriptTimeoutMs: 0 }),
        /positive safe integer/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
