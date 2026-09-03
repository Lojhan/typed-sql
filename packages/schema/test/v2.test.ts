import { describe, it, strict } from "poku";
import {
  defineSchemaSnapshotV2,
  fingerprintSchemaExpression,
  parseSchemaSnapshot,
  type SchemaSnapshotV1,
  type SchemaSnapshotV2,
  upgradeSchemaSnapshotV1,
} from "../src/index.js";

const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;

const v2 = {
  formatVersion: 2,
  dialect: "postgres",
  dialectVersion: "2.0.0",
  server: {
    product: "postgres",
    version: "18.6",
    versionKey: "18",
    features: ["citext:1.6"],
    settings: { standardConformingStrings: "on" },
  },
  namespaces: {
    public: { name: "public", kind: "schema" },
  },
  types: {
    int8: { kind: "scalar", name: "int8", identity: "pg:20", databaseType: "bigint", tsType: "bigint" },
    status: {
      kind: "enum",
      name: "status",
      schema: "public",
      identity: "pg:status",
      databaseType: "status",
      tsType: '"active" | "disabled"',
      labels: ["active", "disabled"],
    },
    email: {
      kind: "domain",
      name: "email",
      schema: "public",
      identity: "pg:email",
      databaseType: "email",
      tsType: "string",
      baseTypeIdentity: "pg:25",
      nullable: false,
      checks: [hashA],
    },
    address: {
      kind: "composite",
      name: "address",
      schema: "public",
      identity: "pg:address",
      databaseType: "address",
      tsType: "{ city: string }",
      fields: [{ name: "city", typeIdentity: "pg:25", databaseType: "text", tsType: "string", nullable: false }],
    },
    int8range: {
      kind: "range",
      name: "int8range",
      identity: "pg:3926",
      databaseType: "int8range",
      tsType: "unknown",
      subtypeIdentity: "pg:20",
    },
    int8multirange: {
      kind: "multirange",
      name: "int8multirange",
      identity: "pg:4536",
      databaseType: "int8multirange",
      tsType: "unknown",
      subtypeIdentity: "pg:20",
    },
    int8array: {
      kind: "collection",
      name: "_int8",
      identity: "pg:1016",
      databaseType: "bigint[]",
      tsType: "readonly bigint[]",
      elementTypeIdentity: "pg:20",
      dimensions: [],
    },
    extensionType: {
      kind: "opaque",
      name: "vector",
      identity: "pg:vector",
      databaseType: "vector",
      tsType: "unknown",
      reason: "The extension type has no configured type policy.",
      extension: { version: "1", attributes: { provider: "vector", dimension: 3 } },
    },
  },
  relations: {
    users: {
      schema: "public",
      name: "users",
      kind: "table",
      columns: {
        id: {
          name: "id",
          position: 0,
          databaseType: "bigint",
          typeIdentity: "pg:20",
          tsType: "bigint",
          nullable: false,
          nullabilitySource: "declared",
          default: "present",
          defaultExpressionHash: hashA,
          generated: "none",
          identity: "by-default",
          classification: "normal",
          insertable: true,
          updatable: true,
        },
        email: {
          name: "email",
          position: 1,
          databaseType: "email",
          typeIdentity: "pg:email",
          tsType: "string",
          nullable: false,
          nullabilitySource: "domain",
          default: "none",
          generated: "none",
          identity: "none",
          collation: "default",
          characterSet: "UTF8",
          dimensions: [],
          classification: "normal",
          insertable: true,
          updatable: true,
        },
      },
      constraints: [
        {
          kind: "unique",
          name: "users_email_key",
          identity: "constraint:2",
          columns: ["email"],
          partial: false,
          expressionBased: false,
          deferrable: false,
          initiallyDeferred: false,
          nullsDistinct: true,
        },
        {
          kind: "primary-key",
          name: "users_pkey",
          identity: "constraint:1",
          columns: ["id"],
          partial: false,
          expressionBased: false,
          deferrable: false,
          initiallyDeferred: false,
          nullsDistinct: false,
        },
        {
          kind: "foreign-key",
          identity: "constraint:3",
          columns: ["id"],
          partial: false,
          expressionBased: false,
          deferrable: true,
          initiallyDeferred: false,
          referencedRelation: "accounts",
          referencedColumns: ["id"],
          match: "simple",
          onUpdate: "cascade",
          onDelete: "restrict",
        },
        {
          kind: "check",
          identity: "constraint:4",
          columns: ["email"],
          partial: false,
          expressionBased: true,
          deferrable: "unknown",
          initiallyDeferred: "unknown",
          predicate: "present",
          predicateHash: hashB,
        },
        {
          kind: "exclusion",
          identity: "constraint:5",
          columns: [],
          partial: true,
          expressionBased: true,
          deferrable: false,
          initiallyDeferred: false,
          elements: [{ expressionHash: hashA, operator: "=", operatorClass: "text_ops", collation: "default" }],
          predicateHash: hashB,
        },
      ],
      indexes: [
        {
          name: "users_email_idx",
          identity: "index:2",
          unique: false,
          method: "btree",
          columns: [{ column: "email", descending: true, nulls: "last", operatorClass: "text_ops" }],
          includedColumns: ["id"],
          predicate: "present",
          predicateHash: hashA,
          valid: true,
        },
        {
          name: "users_email_expr_idx",
          identity: "index:1",
          unique: true,
          columns: [{ expressionHash: hashB }],
          predicate: "none",
          valid: "unknown",
        },
      ],
      capabilities: { insertable: true, replicaIdentity: "default" },
    },
  },
  routines: {
    "public.find_users": [
      {
        name: "find_users",
        schema: "public",
        identity: "routine:2",
        kind: "function",
        arguments: [
          {
            name: "status",
            mode: "in",
            typeIdentity: "pg:status",
            databaseType: "status",
            tsType: '"active" | "disabled"',
            default: "present",
          },
        ],
        result: { kind: "set", typeIdentity: "pg:20", databaseType: "bigint", tsType: "bigint", nullable: false },
        volatility: "stable",
        deterministic: "unknown",
        dataAccess: "reads-sql",
        nullInput: "called",
        availableSince: "14",
        polymorphicFamily: "none",
      },
      {
        name: "find_users",
        schema: "public",
        identity: "routine:1",
        kind: "procedure",
        arguments: [],
        result: { kind: "command" },
        volatility: "volatile",
        deterministic: false,
        dataAccess: "modifies-sql",
        nullInput: "unknown",
        availableUntil: "19",
      },
    ],
  },
  metadata: {
    generatorVersion: "2.0.0",
    schemaHash: "a".repeat(64),
    typePolicyHash: "b".repeat(64),
    schemaFormat: 2,
  },
} as const;

type MutableV2Fixture = Record<string, unknown> & {
  dialectVersion: string;
  namespaces: unknown;
  types: {
    status: { labels: unknown };
    email: { checks: unknown };
    extensionType: { extension: { attributes: Record<string, unknown> } };
  };
  relations: {
    users: {
      columns: { id: { position: number }; email: { position: number } };
      constraints: Record<string, unknown>[];
      indexes: { columns: Record<string, unknown>[] }[];
    };
  };
  routines: Record<string, { arguments: Record<string, unknown>[]; dataAccess: unknown }[]>;
};

await describe("schema snapshot v2", async () => {
  await it("parses the complete neutral envelope and derives v1 resolver views", () => {
    const parsed = parseSchemaSnapshot(v2);
    strict.deepStrictEqual(parseSchemaSnapshot(parsed), parsed);
    strict.strictEqual(parsed.formatVersion, 2);
    const snapshot = parsed as SchemaSnapshotV2;
    strict.deepStrictEqual(
      snapshot.relations.users?.constraints.map(({ identity }) => identity),
      ["constraint:1", "constraint:2", "constraint:3", "constraint:4", "constraint:5"],
    );
    strict.deepStrictEqual(
      snapshot.relations.users?.indexes.map(({ identity }) => identity),
      ["index:1", "index:2"],
    );
    strict.deepStrictEqual(
      snapshot.routines["public.find_users"]?.map(({ identity }) => identity),
      ["routine:1", "routine:2"],
    );
    strict.strictEqual(snapshot.tables.users?.columns.id?.tsType, "bigint");
    strict.deepStrictEqual(snapshot.enums?.status, ["active", "disabled"]);
    strict.strictEqual(snapshot.domains?.email?.tsType, "string");
    strict.strictEqual(snapshot.functions?.["public.find_users(status)"]?.setReturning, true);
    strict.strictEqual(snapshot.metadata?.schemaHash, "a".repeat(64));
  });

  await it("upgrades v1 conservatively without inventing evidence", () => {
    const legacy: SchemaSnapshotV1 = {
      formatVersion: 1,
      dialect: "acme",
      dialectVersion: "4.2.0",
      version: "4.2",
      server: {
        product: "acme",
        version: "4.2",
        versionKey: "4",
        features: ["routines"],
        settings: {},
      },
      tables: {
        users: {
          schema: "app",
          name: "users",
          columns: {
            id: { name: "id", databaseType: "int", tsType: "number", nullable: false },
            name: {
              name: "name",
              databaseType: "text",
              tsType: "string",
              nullable: true,
              array: true,
              defaultExpression: "'anonymous'",
            },
          },
        },
      },
      enums: { "app.status": ["active", "disabled"], empty: [] },
      domains: {
        "app.email": { name: "email", databaseType: "text", tsType: "string", nullable: false },
      },
      functions: {
        "app.find_users(status)": {
          name: "find_users",
          schema: "app",
          argumentTypes: ["status"],
          databaseReturnType: "int8",
          returnType: "bigint",
          nullable: false,
          setReturning: true,
          volatility: "stable",
        },
        "health()": {
          name: "health",
          argumentTypes: [],
          returnType: "string",
          nullable: true,
        },
      },
    };
    const upgraded = upgradeSchemaSnapshotV1(legacy);
    strict.strictEqual(upgraded.formatVersion, 2);
    strict.strictEqual(upgraded.dialectVersion, "4.2.0");
    strict.strictEqual(upgraded.server.versionKey, "4");
    strict.strictEqual(upgraded.relations.users?.capabilities?.evidenceComplete, false);
    strict.strictEqual(upgraded.relations.users?.columns.id?.default, "unknown");
    strict.match(upgraded.relations.users?.columns.name?.defaultExpressionHash ?? "", /^sha256:/u);
    strict.deepStrictEqual(upgraded.relations.users?.columns.name?.dimensions, []);
    strict.deepStrictEqual(upgraded.relations.users?.constraints, []);
    strict.deepStrictEqual(upgraded.namespaces, { app: { name: "app", kind: "schema" } });
    strict.strictEqual(upgraded.types["app.status"]?.kind, "enum");
    strict.strictEqual(upgraded.types.empty?.tsType, "string");
    strict.strictEqual(upgraded.types["app.email"]?.kind, "domain");
    strict.strictEqual(upgraded.routines["app.find_users"]?.[0]?.result.kind, "set");
    strict.strictEqual(upgraded.routines.health?.[0]?.result.kind, "scalar");
  });

  await it("accepts alternate optional v2 evidence and derives non-scalar routine views", () => {
    const input = structuredClone(v2) as unknown as MutableV2Fixture;
    Object.assign(input, {
      extension: {
        version: "1",
        attributes: { empty: "", enabled: true, missing: null, weights: [1, 2], nested: { mode: "strict" } },
      },
    });
    Object.assign((input.namespaces as Record<string, Record<string, unknown>>).public!, {
      extension: { version: "1", attributes: { catalog: true } },
    });
    Object.assign(input.relations.users.columns.id, {
      generatedExpressionHash: fingerprintSchemaExpression("id + 1"),
      dimensions: [2],
      insertable: "unknown",
      extension: { version: "1", attributes: { ordinal: 1 } },
    });
    Object.assign(input.relations.users.constraints[0]!, {
      extension: { version: "1", attributes: { enforced: true } },
    });
    Object.assign(input.relations.users.indexes[0]!, {
      extension: { version: "1", attributes: { clustered: false } },
    });
    const routines = input.routines as Record<string, Record<string, unknown>[]>;
    routines.records = [
      {
        name: "records",
        identity: "routine:record",
        kind: "window",
        arguments: [
          { mode: "inout", typeIdentity: "pg:20", databaseType: "bigint", tsType: "bigint", default: "none" },
          { mode: "out", typeIdentity: "pg:25", databaseType: "text", tsType: "string", default: "unknown" },
          { mode: "variadic", typeIdentity: "pg:20", databaseType: "bigint", tsType: "bigint", default: "none" },
        ],
        result: { kind: "record", columns: {} },
        volatility: "unknown",
        deterministic: true,
        dataAccess: "contains-sql",
        nullInput: "strict",
        extension: { version: "1", attributes: { source: "catalog" } },
      },
      {
        name: "records",
        identity: "routine:table",
        kind: "aggregate",
        arguments: [],
        result: { kind: "table", columns: {} },
        volatility: "immutable",
        deterministic: "unknown",
        dataAccess: "none",
        nullInput: "unknown",
      },
    ];
    const parsed = defineSchemaSnapshotV2(input as unknown as SchemaSnapshotV2);
    strict.strictEqual(parsed.extension?.attributes.enabled, true);
    strict.strictEqual(parsed.functions?.["records(bigint,bigint)"]?.returnType, "unknown");
    strict.strictEqual(parsed.functions?.["records()"]?.databaseReturnType, "table");
  });

  await it("rejects malformed and unknown v2 evidence at precise paths", () => {
    const failures: readonly [mutate: (value: MutableV2Fixture) => void, expected: RegExp][] = [
      [(value) => Object.assign(value, { unexpected: true }), /schema contains unknown properties: unexpected/u],
      [(value) => Object.assign(value, { dialectVersion: "" }), /schema.dialectVersion/u],
      [(value) => Object.assign(value, { namespaces: [] }), /schema.namespaces/u],
      [(value) => Object.assign(value, { metadata: { ...v2.metadata, schemaFormat: 3 } }), /schema.metadata/u],
      [(value) => Object.assign(value.types.status, { labels: [1] }), /schema.types.status.labels\[0\]/u],
      [(value) => Object.assign(value.types.email, { checks: ["raw predicate"] }), /schema.types.email.checks\[0\]/u],
      [
        (value) => Object.assign(value.types.extensionType.extension, { attributes: [] }),
        /attributes must be an object/u,
      ],
      [
        (value) => Object.assign(value.types.extensionType.extension.attributes, { weight: Number.POSITIVE_INFINITY }),
        /must be finite/u,
      ],
      [(value) => Object.assign(value.relations.users.columns.id, { position: -1 }), /columns.id.position/u],
      [
        (value) => Object.assign(value.relations.users.columns.id, { dimensions: "one" }),
        /dimensions must be an array/u,
      ],
      [(value) => Object.assign(value.relations.users.columns.id, { nullable: "no" }), /nullable must be a boolean/u],
      [(value) => Object.assign(value.relations.users.columns.id, { name: "bad\nname" }), /safe artifact text/u],
      [(value) => Object.assign(value.relations.users.columns.email, { position: 0 }), /positions must be unique/u],
      [(value) => Object.assign(value.relations.users, { constraints: {} }), /constraints must be an array/u],
      [(value) => Object.assign(value.relations.users, { indexes: {} }), /indexes must be an array/u],
      [
        (value) => Object.assign(value.relations.users, { capabilities: { estimate: Number.NaN } }),
        /must be a string, boolean, or finite number/u,
      ],
      [
        (value) => Object.assign(value.relations.users.constraints[1]!, { nullsDistinct: true }),
        /nullsDistinct must be false/u,
      ],
      [
        (value) => Object.assign(value.relations.users.constraints[0]!, { nullsDistinct: "sometimes" }),
        /nullsDistinct/u,
      ],
      [
        (value) => Object.assign(value.relations.users.indexes[0]!.columns[0]!, { expressionHash: hashA }),
        /exactly one/u,
      ],
      [(value) => Object.assign(value.relations.users.indexes[0]!, { columns: {} }), /columns must be an array/u],
      [
        (value) => Object.assign((value.types as Record<string, Record<string, unknown>>).address!, { fields: {} }),
        /fields must be an array/u,
      ],
      [
        (value) =>
          Object.assign((value.types as Record<string, Record<string, unknown>>).int8array!, { dimensions: 1 }),
        /dimensions must be an array/u,
      ],
      [
        (value) => Object.assign(value.routines["public.find_users"]![0]!, { arguments: {} }),
        /arguments must be an array/u,
      ],
      [(value) => Object.assign(value.routines["public.find_users"]![0]!.arguments[0]!, { mode: "return" }), /mode/u],
      [(value) => Object.assign(value.routines["public.find_users"]![0]!, { dataAccess: "network" }), /dataAccess/u],
      [
        (value) => Object.assign(value.types.extensionType.extension.attributes, { password: "redacted" }),
        /not allowed in schema extension evidence/u,
      ],
      [(value) => Object.assign(value.routines, { invalid: {} }), /schema.routines.invalid must be an array/u],
    ];
    for (const [mutate, expected] of failures) {
      const input = structuredClone(v2) as unknown as MutableV2Fixture;
      mutate(input);
      strict.throws(() => parseSchemaSnapshot(input), expected);
    }
    strict.throws(
      () => defineSchemaSnapshotV2({ ...v2, formatVersion: 1 } as unknown as SchemaSnapshotV2),
      /formatVersion must be 2/u,
    );
  });
});
