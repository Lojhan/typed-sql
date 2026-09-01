import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  calculateSchemaHash,
  checkSchemaDrift,
  generateSchemaPackage,
  loadGeneratedSchemaSnapshot,
  type SchemaSnapshot,
  serializeSchemaSnapshot,
  upgradeSchemaSnapshotV1,
} from "../src/index.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
      },
    },
  },
} as const satisfies SchemaSnapshot;

await describe("schema package generation", async () => {
  await it("emits TypeScript, JSON, and reproducible hashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-generator-"));
    try {
      const first = await generateSchemaPackage(schema, { outDir: directory, generatorVersion: "test" });
      const second = await generateSchemaPackage(schema, { outDir: directory, generatorVersion: "test" });
      strict.deepStrictEqual(first, second);
      const moduleSource = await readFile(join(directory, "index.ts"), "utf8");
      const jsonSource = await readFile(join(directory, "schema.json"), "utf8");
      strict.ok(moduleSource.includes("export const schema"));
      strict.ok(moduleSource.includes(first.schemaHash));
      strict.ok(moduleSource.includes("Schema metadata only"));
      strict.ok(!moduleSource.includes("export { sql }"));
      strict.ok(!moduleSource.includes("export const typePolicy"));
      strict.ok(!moduleSource.includes("createGeneratedDatabase"));
      strict.ok(jsonSource.includes(first.typePolicyHash));

      const generated = await loadGeneratedSchemaSnapshot(join(directory, "schema.json"));
      strict.strictEqual(generated.formatVersion, 2);
      strict.strictEqual(generated.metadata.schemaFormat, 2);
      strict.ok(jsonSource.includes('"relations"'));
      strict.ok(!jsonSource.includes('"tables"'));
      strict.strictEqual(checkSchemaDrift(generated, schema).drifted, false);
      const changed = { ...schema, version: "18" } satisfies SchemaSnapshot;
      const drift = checkSchemaDrift(generated, changed);
      strict.strictEqual(drift.drifted, true);
      strict.strictEqual(drift.schemaChanged, true);
      strict.strictEqual(drift.typePolicyChanged, false);
      strict.ok(drift.changes.some(({ kind }) => kind === "server"));
      const serverChanged = {
        ...schema,
        version: "18.6",
        server: {
          product: "postgres",
          version: "18.6",
          versionKey: "18",
          features: ["plpgsql:1.0"],
          settings: { standardConformingStrings: "on" },
        },
      } satisfies SchemaSnapshot;
      const changedSetting = {
        ...serverChanged,
        server: { ...serverChanged.server, settings: { standardConformingStrings: "off" } },
      } satisfies SchemaSnapshot;
      strict.notStrictEqual(calculateSchemaHash(serverChanged), calculateSchemaHash(changedSetting));
      strict.strictEqual(
        checkSchemaDrift(
          {
            ...serverChanged,
            metadata: {
              generatorVersion: "test",
              schemaHash: calculateSchemaHash(serverChanged),
              typePolicyHash: generated.metadata.typePolicyHash,
            },
          },
          changedSetting,
        ).schemaChanged,
        true,
      );
      const policyDrift = checkSchemaDrift(generated, schema, { bigint: "string" });
      strict.strictEqual(policyDrift.drifted, true);
      strict.strictEqual(policyDrift.schemaChanged, false);
      strict.strictEqual(policyDrift.typePolicyChanged, true);
      strict.deepStrictEqual(policyDrift.changes, [{ kind: "type-policy", key: "type-policy" }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("canonicalizes v2 maps and unordered semantic arrays before serialization and hashing", () => {
    const upgraded = upgradeSchemaSnapshotV1(schema);
    const users = upgraded.relations.users!;
    const primary = {
      kind: "primary-key" as const,
      name: "users_pkey",
      identity: "constraint:1",
      columns: ["id"],
      partial: false,
      expressionBased: false,
      deferrable: false,
      initiallyDeferred: false,
      nullsDistinct: false as const,
    };
    const unique = {
      kind: "unique" as const,
      name: "users_id_key",
      identity: "constraint:2",
      columns: ["id"],
      partial: false,
      expressionBased: false,
      deferrable: false,
      initiallyDeferred: false,
      nullsDistinct: true,
    };
    const ascending = {
      name: "users_a_idx",
      identity: "index:1",
      unique: false,
      columns: [{ column: "id" }],
      predicate: "none" as const,
      valid: true,
    };
    const descending = {
      name: "users_z_idx",
      identity: "index:2",
      unique: false,
      columns: [{ column: "id", descending: true }],
      predicate: "none" as const,
      valid: true,
    };
    const first = {
      ...upgraded,
      relations: {
        users: { ...users, constraints: [unique, primary], indexes: [descending, ascending] },
      },
    };
    const second = {
      ...upgraded,
      relations: {
        users: { ...users, constraints: [primary, unique], indexes: [ascending, descending] },
      },
    };
    strict.strictEqual(serializeSchemaSnapshot(first), serializeSchemaSnapshot(second));
    strict.strictEqual(calculateSchemaHash(first), calculateSchemaHash(second));
    strict.strictEqual(calculateSchemaHash(first), "a48cb6794146d3b009da66d5ba4129cd283f8eadc756ff9ef1fe7f39579f5b7a");
    strict.ok(!serializeSchemaSnapshot(first).includes("defaultExpression"));
  });
});
