import { describe, it, strict } from "poku";
import {
  assertSqlServerRuntimeEvidence,
  assertSqlServerServerEvidence,
  resolveSqlServerCapabilities,
} from "../src/capabilities.js";
import { parseSqlServerNativeType, requireSqlServerNativeType, validateSqlServerDecimal } from "../src/native-types.js";
import { normalizeSqlServerValue, sqlServerRenderer } from "../src/query.js";
import { parseSqlServerSchemaSnapshot } from "../src/snapshot.js";
import {
  defaultSqlServerTypePolicy,
  mapSqlServerType,
  type SqlServerTypePolicy,
  sqlServerRuntimeValueType,
  validateSqlServerTypePolicy,
} from "../src/type-policy.js";
import { serverEvidence } from "./helpers/environment.js";

const snapshot = {
  formatVersion: 1,
  dialect: "sqlserver",
  server: serverEvidence,
  tables: {
    t: {
      name: "t",
      schema: "dbo",
      columns: { id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false } },
    },
  },
} as const;
await describe("SQL Server public policy and evidence boundaries", async () => {
  await it("quotes native identifiers and bounds logical placeholders", () => {
    strict.equal(sqlServerRenderer.quoteIdentifier("a]b"), "[a]]b]");
    strict.equal(sqlServerRenderer.placeholder(2100), "@__typed_sql_2100");
    for (const index of [0, -1, 1.5, 2101, NaN, Infinity]) strict.throws(() => sqlServerRenderer.placeholder(index));
    for (const name of ["", "a\0b", "a".repeat(129)]) strict.throws(() => sqlServerRenderer.quoteIdentifier(name));
  });
  await it("normalizes only declared wire categories and never manufactures precision", () => {
    strict.equal(normalizeSqlServerValue("-9223372036854775808", "bigint"), -9223372036854775808n);
    strict.equal(normalizeSqlServerValue("1.25e2", "number"), 125);
    strict.equal(normalizeSqlServerValue("2024-01-01T00:00:00Z", "date") instanceof Date, true);
    const bytes = Uint8Array.of(0, 255);
    strict.notEqual(normalizeSqlServerValue(bytes, "bytes"), bytes);
    const object = { id: 1 };
    strict.equal(normalizeSqlServerValue(object, "unknown"), object);
    for (const [value, type] of [
      ["x", "bigint"],
      ["NaN", "number"],
      ["1e309", "number"],
      ["9007199254740993", "number"],
      ["invalid", "date"],
    ] as const)
      strict.throws(() => normalizeSqlServerValue(value, type));
  });
  await it("maps deliberate alternative policies and structured runtime descriptors", () => {
    const policy: SqlServerTypePolicy = {
      bigint: "string",
      decimal: "Decimal",
      temporal: "Date",
      json: "parsed",
      unknown: "never",
    };
    strict.equal(Object.isFrozen(validateSqlServerTypePolicy(policy)), true);
    for (const [native, ts] of [
      ["int", "number"],
      ["real", "number"],
      ["bit", "boolean"],
      ["bigint", "string"],
      ["decimal(38,10)", "Decimal"],
      ["time(7)", "Date"],
      ["json", "JsonValue"],
      ["sql_variant", "never"],
      ["dbo.Geometry", "never"],
      ["nvarchar(max)", "string"],
      ["binary(8)", "Uint8Array"],
    ])
      strict.equal(mapSqlServerType(native!, policy), ts);
    for (const [tsType, expected] of [
      ["Date", "date"],
      ["Uint8Array", "bytes"],
      ["Decimal", "unknown"],
      ["never", "never"],
      ["boolean", "boolean"],
      ["number", "number"],
      ["bigint", "bigint"],
    ])
      strict.equal(sqlServerRuntimeValueType({ tsType: tsType!, nullable: false }, policy), expected);
    strict.deepEqual(sqlServerRuntimeValueType({ tsType: "JsonValue", nullable: true }, policy), {
      json: { shape: { kind: "unknown" }, representation: "parsed" },
    });
    strict.deepEqual(sqlServerRuntimeValueType({ tsType: "JsonValue", nullable: true }), {
      json: { shape: { kind: "unknown" }, representation: "text" },
    });
    for (const [key, value] of [
      ["bigint", "BigInt"],
      ["decimal", "numberish"],
      ["temporal", "date"],
      ["json", "unknown"],
      ["unknown", "any"],
    ])
      strict.throws(() =>
        validateSqlServerTypePolicy({ ...defaultSqlServerTypePolicy, [key!]: value } as SqlServerTypePolicy),
      );
  });
  await it("allows bounded physical targets and rejects type/collation injection", () => {
    for (const [source, canonical] of [
      ["character varying(8)", "varchar(8)"],
      ["double precision", "float(53)"],
      ["decimal", "decimal(18,0)"],
      ["float(24)", "real"],
      ["time(0)", "time(0)"],
      ["varchar(8) COLLATE Latin1_General_100_CI_AS_SC_UTF8", "varchar(8) COLLATE Latin1_General_100_CI_AS_SC_UTF8"],
    ])
      strict.equal(parseSqlServerNativeType(source!)?.text, canonical);
    for (const source of [
      "int COLLATE Latin1_General_100_CI_AS",
      "varchar(2) COLLATE a;DROP TABLE t",
      "varchar(2) COLLATE a COLLATE b",
      "varchar(2,3)",
      "time(3,2)",
      "float(2,1)",
      "decimal(max)",
      "float(max)",
      "time(max)",
      "char(0)",
      "numeric(0)",
      "varchar(99999999999999999999)",
      "x".repeat(513),
    ])
      strict.equal(parseSqlServerNativeType(source), undefined, source);
    for (const value of ["NaN", "Infinity", "1e3", "1.", "1".repeat(97)])
      strict.throws(() => validateSqlServerDecimal(value, requireSqlServerNativeType("decimal(38,0)")));
    strict.equal(validateSqlServerDecimal("+0001.2300", requireSqlServerNativeType("decimal(4,2)")), "1.23");
  });
  await it("requires qualified immutable engine, product and canonical-session evidence", () => {
    assertSqlServerRuntimeEvidence(serverEvidence);
    strict.equal(resolveSqlServerCapabilities(snapshot).syntax?.level, "exact");
    strict.equal(
      resolveSqlServerCapabilities({
        ...snapshot,
        server: {
          ...serverEvidence,
          version: "14.0.3560.2",
          versionKey: "14",
          settings: { ...serverEvidence.settings, compatibilityLevel: 140 },
        },
      }).nativeJson?.level,
      "unsupported",
    );
    strict.equal(
      resolveSqlServerCapabilities({
        ...snapshot,
        server: {
          ...serverEvidence,
          version: "13.0.1.1",
          versionKey: "13",
          settings: { ...serverEvidence.settings, compatibilityLevel: 130 },
        },
      }).syntax?.level,
      "unsupported",
    );
    strict.equal(
      resolveSqlServerCapabilities({ formatVersion: 1, dialect: "sqlserver", tables: {} }).syntax?.level,
      "conservative",
    );
    for (const key of ["quotedIdentifier", "ansiWarnings", "arithAbort", "concatNullOn"])
      strict.throws(
        () =>
          assertSqlServerRuntimeEvidence({ ...serverEvidence, settings: { ...serverEvidence.settings, [key]: false } }),
        /canonical/,
      );
    for (const [key, value] of [
      ["unmodeled", true],
      ["dateFirst", 8],
      ["compatibilityLevel", NaN],
      ["engineEdition", 0],
      ["collation", ""],
      ["quotedIdentifier", "on"],
    ] as const)
      strict.throws(() =>
        assertSqlServerServerEvidence({ ...serverEvidence, settings: { ...serverEvidence.settings, [key]: value } }),
      );
    strict.throws(() => assertSqlServerServerEvidence({ ...serverEvidence, product: "azure-sql" }));
    strict.throws(() => assertSqlServerServerEvidence({ ...serverEvidence, versionKey: "16" }));
    strict.throws(
      () => assertSqlServerRuntimeEvidence({ ...serverEvidence, version: "18.0.1.1", versionKey: "18" }),
      /qualified/,
    );
  });
  await it("validates persisted snapshots without requiring database drivers", () => {
    const parsed = parseSqlServerSchemaSnapshot(snapshot);
    strict.equal(parsed.dialect, "sqlserver");
    strict.throws(() => parseSqlServerSchemaSnapshot({ ...snapshot, dialect: "postgres" }), /dialect/);
    strict.throws(() => parseSqlServerSchemaSnapshot({ ...snapshot, dialectVersion: "99.0.0" }), /version/);
    strict.throws(
      () =>
        parseSqlServerSchemaSnapshot({
          ...snapshot,
          tables: {
            t: {
              ...snapshot.tables.t,
              columns: { id: { ...snapshot.tables.t.columns.id, databaseType: "x".repeat(257) } },
            },
          },
        }),
      /bound/,
    );
    const opaque = parseSqlServerSchemaSnapshot({
      ...snapshot,
      tables: {
        t: {
          ...snapshot.tables.t,
          columns: { id: { ...snapshot.tables.t.columns.id, databaseType: "dbo.[Custom Type]", tsType: "unknown" } },
        },
      },
    });
    strict.equal(opaque.tables.t?.columns.id?.tsType, "unknown");
  });
});
