import { describe, it, strict } from "poku";
import {
  calculateSchemaHash,
  parseSchemaSnapshot,
  serializeSchemaSnapshot,
  upgradeSchemaSnapshotV1,
  withSchemaBrands,
} from "../src/index.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  domains: { user_id: { name: "user_id", databaseType: "bigint", tsType: "bigint", nullable: false } },
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "user_id", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "text", tsType: "string", nullable: true },
        opaque: { name: "opaque", databaseType: "jsonb", tsType: "unknown", nullable: true },
      },
    },
  },
} as const;

await describe("application schema brands", async () => {
  await it("brands domains and columns immutably and retains canonical snapshot/hash evidence", () => {
    const branded = withSchemaBrands(schema, {
      domains: { user_id: "UserId" },
      columns: { users: { email: "Email" } },
    });
    strict.match(branded.tables.users!.columns.id!.tsType, /Brand<bigint, "UserId">/u);
    strict.match(branded.tables.users!.columns.email!.tsType, /Brand<string, "Email">/u);
    strict.strictEqual(branded.tables.users!.columns.email!.nullable, true);
    strict.strictEqual(schema.tables.users.columns.email.tsType, "string");
    strict.notStrictEqual(calculateSchemaHash(branded), calculateSchemaHash(schema));
    const parsed = parseSchemaSnapshot(JSON.parse(serializeSchemaSnapshot(branded)));
    strict.deepStrictEqual(parsed, branded);
    const refreshed = withSchemaBrands(
      {
        ...upgradeSchemaSnapshotV1(branded),
        metadata: { generatorVersion: "test", schemaHash: "stale", typePolicyHash: "stale" },
      },
      {},
    );
    strict.strictEqual(refreshed.metadata, undefined);
  });
  await it("applies the same domain and column identities to canonical v2 snapshots", () => {
    const original = upgradeSchemaSnapshotV1(schema);
    const branded = withSchemaBrands(original, {
      domains: { user_id: "UserId" },
      columns: { users: { email: "Email" } },
    });
    strict.match(branded.relations.users!.columns.id!.tsType, /Brand<bigint, "UserId">/u);
    strict.strictEqual(branded.tables.users!.columns.id!.tsType, branded.relations.users!.columns.id!.tsType);
    strict.match(branded.types.user_id!.tsType, /Brand<bigint, "UserId">/u);
    strict.deepStrictEqual(parseSchemaSnapshot(JSON.parse(serializeSchemaSnapshot(branded))), branded);
    for (const brands of [
      { domains: { absent: "Id" } },
      { columns: { absent: { id: "Id" } } },
      { columns: { users: { absent: "Id" } } },
      { columns: { users: { opaque: "Id" } } },
    ])
      strict.throws(() => withSchemaBrands(original, brands));
  });

  await it("rejects unknown identities, opaque/structured scalars and unsafe brand names", () => {
    for (const brands of [
      { domains: { absent: "Id" } },
      { columns: { absent: { id: "Id" } } },
      { columns: { users: { absent: "Id" } } },
      { columns: { users: { opaque: "Id" } } },
      { columns: { users: { email: "" } } },
      { columns: { users: { email: "x".repeat(201) } } },
      { columns: { users: { email: "line\nbreak" } } },
    ])
      strict.throws(() => withSchemaBrands(schema, brands));
    const declared = {
      ...schema,
      tables: {
        users: {
          ...schema.tables.users,
          columns: {
            ...schema.tables.users.columns,
            email: {
              ...schema.tables.users.columns.email,
              jsonDeclaration: { source: "application" as const, shape: { kind: "string" as const } },
            },
          },
        },
      },
    };
    strict.throws(() => withSchemaBrands(declared, { columns: { users: { email: "Email" } } }), /JSON declarations/u);
  });
});
