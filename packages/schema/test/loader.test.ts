import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  loadGeneratedSchemaSnapshot,
  loadSchemaSnapshot,
  loadTypePolicy,
  migrateSchemaSnapshot,
  parseSchemaSnapshot,
  parseTypePolicy,
} from "../src/index.js";

const fullSnapshot = {
  formatVersion: 1,
  dialect: "postgres",
  dialectVersion: "0.2.0",
  version: "18.6",
  tables: {
    users: {
      schema: "public",
      name: "users",
      columns: {
        id: {
          name: "id",
          databaseType: "bigint",
          tsType: "bigint",
          nullable: false,
          array: false,
          defaultExpression: "nextval('users_id_seq')",
        },
      },
    },
  },
  enums: { status: ["active", "disabled"] },
  domains: { email: { name: "email", databaseType: "text", tsType: "string", nullable: false } },
  functions: {
    "count_users()": {
      name: "count_users",
      schema: "public",
      argumentTypes: [],
      databaseReturnType: "bigint",
      returnType: "bigint",
      nullable: false,
      setReturning: false,
      volatility: "stable",
    },
  },
} as const;

const policy = {
  bigint: "bigint",
  numeric: "string",
  date: "Date",
  json: "unknown",
  enums: "string-union",
  unknown: "unknown",
} as const;

await describe("schema snapshot loader", async () => {
  await it("migrates unversioned pre-1.0 snapshots to stable format 1", () => {
    const { formatVersion: _formatVersion, ...legacy } = fullSnapshot;
    strict.deepStrictEqual(migrateSchemaSnapshot(legacy), fullSnapshot);
    strict.strictEqual(parseSchemaSnapshot(legacy).formatVersion, 1);
  });
  await it("accepts dialect identifiers owned by third-party grammar packages", () => {
    const snapshot = parseSchemaSnapshot({
      formatVersion: 1,
      dialect: "acme-warehouse",
      dialectVersion: "2.4.0",
      tables: {},
    });
    strict.strictEqual(snapshot.dialect, "acme-warehouse");
    strict.strictEqual(snapshot.dialectVersion, "2.4.0");
  });
  await it("loads complete snapshots, generated metadata, and policies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-loader-"));
    try {
      const schemaFile = join(directory, "schema.json");
      const generatedFile = join(directory, "generated.json");
      const policyFile = join(directory, "policy.json");
      await writeFile(schemaFile, JSON.stringify(fullSnapshot));
      await writeFile(
        generatedFile,
        JSON.stringify({
          ...fullSnapshot,
          metadata: { generatorVersion: "test", schemaHash: "schema", typePolicyHash: "policy" },
        }),
      );
      await writeFile(policyFile, JSON.stringify(policy));
      strict.deepStrictEqual(await loadSchemaSnapshot(schemaFile), fullSnapshot);
      strict.strictEqual((await loadGeneratedSchemaSnapshot(generatedFile)).metadata.schemaHash, "schema");
      strict.deepStrictEqual(await loadTypePolicy(policyFile), policy);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("validates every nested snapshot shape", () => {
    const failures: readonly [unknown, RegExp][] = [
      [null, /snapshot must be an object/],
      [{ dialect: "", tables: {} }, /schema.dialect/],
      [{ dialect: "oracle", dialectVersion: 1, tables: {} }, /schema.dialectVersion/],
      [{ dialect: "postgres", tables: [] }, /schema.tables/],
      [{ dialect: "postgres", tables: {}, formatVersion: 2 }, /formatVersion/],
      [{ dialect: "postgres", tables: { users: null } }, /users must be an object/],
      [{ dialect: "postgres", tables: { users: { columns: {} } } }, /users.name/],
      [{ dialect: "postgres", tables: { users: { name: "users", schema: 1, columns: {} } } }, /users.schema/],
      [{ dialect: "postgres", tables: { users: { name: "users", columns: [] } } }, /users.columns/],
      [
        { dialect: "postgres", tables: { users: { name: "users", columns: { id: null } } } },
        /columns.id must be an object/,
      ],
      [
        {
          dialect: "postgres",
          tables: {
            users: { name: "users", columns: { id: { databaseType: "int", tsType: "number", nullable: false } } },
          },
        },
        /id.name/,
      ],
      [
        {
          dialect: "postgres",
          tables: { users: { name: "users", columns: { id: { name: "id", tsType: "number", nullable: false } } } },
        },
        /databaseType/,
      ],
      [
        {
          dialect: "postgres",
          tables: { users: { name: "users", columns: { id: { name: "id", databaseType: "int", nullable: false } } } },
        },
        /tsType/,
      ],
      [
        {
          dialect: "postgres",
          tables: { users: { name: "users", columns: { id: { name: "id", databaseType: "int", tsType: "number" } } } },
        },
        /nullable/,
      ],
      [
        {
          dialect: "postgres",
          tables: {
            users: {
              name: "users",
              columns: { id: { name: "id", databaseType: "int", tsType: "number", nullable: false, array: "no" } },
            },
          },
        },
        /array/,
      ],
      [
        {
          dialect: "postgres",
          tables: {
            users: {
              name: "users",
              columns: {
                id: { name: "id", databaseType: "int", tsType: "number", nullable: false, defaultExpression: 1 },
              },
            },
          },
        },
        /defaultExpression/,
      ],
      [{ dialect: "postgres", tables: {}, enums: [] }, /schema.enums/],
      [{ dialect: "postgres", tables: {}, enums: { status: [1] } }, /status must be a string array/],
      [{ dialect: "postgres", tables: {}, domains: [] }, /schema.domains/],
      [{ dialect: "postgres", tables: {}, domains: { email: null } }, /email must be an object/],
      [
        {
          dialect: "postgres",
          tables: {},
          domains: { email: { databaseType: "text", tsType: "string", nullable: false } },
        },
        /email.name/,
      ],
      [
        { dialect: "postgres", tables: {}, domains: { email: { name: "email", tsType: "string", nullable: false } } },
        /databaseType/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          domains: { email: { name: "email", databaseType: "text", nullable: false } },
        },
        /tsType/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          domains: { email: { name: "email", databaseType: "text", tsType: "string" } },
        },
        /nullable/,
      ],
      [{ dialect: "postgres", tables: {}, functions: { f: null } }, /f must be an object/],
      [
        {
          dialect: "postgres",
          tables: {},
          functions: { f: { argumentTypes: [], returnType: "number", nullable: false } },
        },
        /f.name/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          functions: { f: { name: "f", argumentTypes: [1], returnType: "number", nullable: false } },
        },
        /argumentTypes/,
      ],
      [
        { dialect: "postgres", tables: {}, functions: { f: { name: "f", argumentTypes: [], nullable: false } } },
        /returnType/,
      ],
      [
        { dialect: "postgres", tables: {}, functions: { f: { name: "f", argumentTypes: [], returnType: "number" } } },
        /nullable/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          functions: { f: { name: "f", argumentTypes: [], returnType: "number", nullable: false, schema: 1 } },
        },
        /f.schema/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          functions: {
            f: { name: "f", argumentTypes: [], returnType: "number", nullable: false, databaseReturnType: 1 },
          },
        },
        /databaseReturnType/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          functions: { f: { name: "f", argumentTypes: [], returnType: "number", nullable: false, setReturning: "no" } },
        },
        /setReturning/,
      ],
      [
        {
          dialect: "postgres",
          tables: {},
          functions: {
            f: { name: "f", argumentTypes: [], returnType: "number", nullable: false, volatility: "sometimes" },
          },
        },
        /volatility/,
      ],
    ];
    for (const [input, expected] of failures) strict.throws(() => parseSchemaSnapshot(input), expected);
  });

  await it("validates generated metadata and every policy field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-loader-errors-"));
    try {
      for (const [metadata, expected] of [
        [null, /metadata must be an object/],
        [{ schemaHash: "s", typePolicyHash: "p" }, /generatorVersion/],
        [{ generatorVersion: "g", typePolicyHash: "p" }, /schemaHash/],
        [{ generatorVersion: "g", schemaHash: "s" }, /typePolicyHash/],
      ] as const) {
        const file = join(directory, `${Math.random()}.json`);
        await writeFile(file, JSON.stringify({ ...fullSnapshot, metadata }));
        await strict.rejects(() => loadGeneratedSchemaSnapshot(file), expected);
      }
      const primitive = join(directory, "primitive.json");
      await writeFile(primitive, "null");
      await strict.rejects(() => loadGeneratedSchemaSnapshot(primitive), /must be an object/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    for (const invalid of [null, [], "postgres"]) strict.throws(() => parseTypePolicy(invalid), /Type policy/);
    strict.deepStrictEqual(parseTypePolicy({ custom: "dialect-owned" }), { custom: "dialect-owned" });
  });
});
