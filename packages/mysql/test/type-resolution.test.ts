import { describe, it, strict } from "poku";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import { mySqlServerEvidence } from "../src/index.js";
import { parseStatement } from "../src/parser/index.js";
import { resolveMySqlStatement } from "../src/resolver.js";

const legacy = {
  formatVersion: 1,
  dialect: "mysql",
  tables: {
    values_table: {
      name: "values_table",
      columns: {
        unsigned_id: {
          name: "unsigned_id",
          databaseType: "bigint unsigned",
          tsType: "bigint",
          nullable: false,
        },
        signed_id: { name: "signed_id", databaseType: "bigint", tsType: "bigint", nullable: false },
        amount: { name: "amount", databaseType: "decimal(12,2)", tsType: "string", nullable: false },
        ratio: { name: "ratio", databaseType: "double", tsType: "number", nullable: false },
        label: { name: "label", databaseType: "varchar(80)", tsType: "string", nullable: false },
      },
    },
  },
  functions: {},
} as const satisfies SchemaSnapshot;

function evidence(version: string, sqlMode = "STRICT_TRANS_TABLES") {
  return mySqlServerEvidence(version, {
    sqlMode,
    characterSetServer: "utf8mb4",
    collationServer: "utf8mb4_0900_ai_ci",
    characterSetConnection: "utf8mb4",
    collationConnection: "utf8mb4_0900_ai_ci",
    timeZone: "+00:00",
    systemTimeZone: "UTC",
    lowerCaseTableNames: 0,
    versionComment: "MySQL Community Server - GPL",
  });
}

function schema(version = "8.4.11", sqlMode = "STRICT_TRANS_TABLES"): SchemaSnapshot {
  const upgraded = upgradeSchemaSnapshotV1(legacy);
  const relation = upgraded.relations.values_table!;
  return {
    ...upgraded,
    server: evidence(version, sqlMode),
    relations: {
      ...upgraded.relations,
      values_table: {
        ...relation,
        columns: {
          ...relation.columns,
          label: {
            ...relation.columns.label!,
            characterSet: "utf8mb4",
            collation: "utf8mb4_0900_ai_ci",
          },
        },
      },
    },
  };
}

await describe("MySQL catalog-backed type resolution", async () => {
  await it("parses character-set introducers and explicit COLLATE with exact spans", () => {
    const statement = parseStatement("SELECT _utf8mb4'value' COLLATE utf8mb4_bin AS value");
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    const expression = statement.columns[0]?.expression;
    strict.strictEqual(expression?.kind, "collate");
    if (expression?.kind !== "collate") return;
    strict.strictEqual(expression.collation.name, "utf8mb4_bin");
    strict.strictEqual(expression.expression.kind, "literal");
    strict.strictEqual(
      expression.expression.kind === "literal" && expression.expression.characterSet?.name,
      "_utf8mb4",
    );

    const result = resolveMySqlStatement(statement, schema());
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.columns[0]?.characterSet, "utf8mb4");
    strict.strictEqual(result.columns[0]?.collation, "utf8mb4_bin");
    strict.strictEqual(result.columns[0]?.coercibility, 0);
  });

  await it("applies coercibility, Unicode, and binary-collation tie breaking", () => {
    const columnComparison = resolveMySqlStatement(
      parseStatement("SELECT label = 'value' AS matches FROM values_table"),
      schema(),
    );
    strict.deepStrictEqual(columnComparison.diagnostics, []);

    const binaryWins = resolveMySqlStatement(
      parseStatement("SELECT CONCAT('a' COLLATE utf8mb4_bin, 'b' COLLATE utf8mb4_0900_ai_ci) AS value"),
      schema(),
    );
    strict.deepStrictEqual(binaryWins.diagnostics, []);
    strict.strictEqual(binaryWins.columns[0]?.collation, "utf8mb4_bin");
    strict.strictEqual(binaryWins.columns[0]?.coercibility, 1);

    const unicodeWins = resolveMySqlStatement(
      parseStatement(`
        SELECT CONCAT(
          _latin1'a' COLLATE latin1_swedish_ci,
          _utf8mb4'b' COLLATE utf8mb4_0900_ai_ci
        ) AS value
      `),
      schema(),
    );
    strict.deepStrictEqual(unicodeWins.diagnostics, []);
    strict.strictEqual(unicodeWins.columns[0]?.characterSet, "utf8mb4");
    strict.strictEqual(unicodeWins.columns[0]?.collation, "utf8mb4_0900_ai_ci");

    const incompatible = resolveMySqlStatement(
      parseStatement("SELECT 'a' COLLATE utf8mb4_0900_ai_ci = 'b' COLLATE utf8mb4_general_ci AS matches"),
      schema(),
    );
    strict.ok(incompatible.diagnostics.some(({ code }) => code === "TSQ203"));
    const invalidCharacterSet = resolveMySqlStatement(
      parseStatement("SELECT _latin1'a' COLLATE utf8mb4_bin AS value"),
      schema(),
    );
    strict.ok(invalidCharacterSet.diagnostics.some(({ code }) => code === "TSQ203"));
    const unknown = resolveMySqlStatement(parseStatement("SELECT 'a' COLLATE made_up_ci AS value"), schema());
    strict.ok(unknown.diagnostics.some(({ code }) => code === "TSQ106"));
  });

  await it("propagates exact, approximate, and unsigned arithmetic", () => {
    const result = resolveMySqlStatement(
      parseStatement(`
        SELECT unsigned_id + 1 AS added,
               unsigned_id - signed_id AS subtracted,
               amount * 2 AS exact_value,
               amount + ratio AS approximate_value,
               amount / 2 AS divided
        FROM values_table
      `),
      schema(),
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, databaseType, nullable, unsigned }) => ({
        name,
        tsType,
        databaseType,
        nullable,
        unsigned,
      })),
      [
        { name: "added", tsType: "bigint", databaseType: "bigint unsigned", nullable: false, unsigned: true },
        { name: "subtracted", tsType: "bigint", databaseType: "bigint unsigned", nullable: false, unsigned: true },
        { name: "exact_value", tsType: "string", databaseType: "decimal", nullable: false, unsigned: false },
        { name: "approximate_value", tsType: "number", databaseType: "double", nullable: false, unsigned: false },
        { name: "divided", tsType: "string", databaseType: "decimal", nullable: true, unsigned: false },
      ],
    );

    const signedSubtraction = resolveMySqlStatement(
      parseStatement("SELECT unsigned_id - signed_id AS value FROM values_table"),
      schema("8.4.11", "NO_UNSIGNED_SUBTRACTION,STRICT_TRANS_TABLES"),
    );
    strict.strictEqual(signedSubtraction.columns[0]?.databaseType, "bigint");
    strict.strictEqual(signedSubtraction.columns[0]?.unsigned, false);
  });

  await it("fails closed on version-gated built-ins", () => {
    const unsupported = resolveMySqlStatement(parseStatement("SELECT VECTOR_DIM(?) AS dimensions"), schema("8.4.11"));
    strict.ok(unsupported.diagnostics.some(({ code }) => code === "TSQ403"));
    strict.strictEqual(unsupported.columns[0]?.tsType, "unknown");

    const supported = resolveMySqlStatement(parseStatement("SELECT VECTOR_DIM(?) AS dimensions"), schema("9.7.2"));
    strict.deepStrictEqual(supported.diagnostics, []);
    strict.strictEqual(supported.columns[0]?.tsType, "number");
    strict.strictEqual(supported.columns[0]?.databaseType, "bigint");
  });

  await it("resolves catalog result families and their nullability", () => {
    const result = resolveMySqlStatement(
      parseStatement(`
        SELECT VERSION() AS server_version,
               LOWER(label) AS lowered,
               UNHEX(label) AS bytes_value,
               NOW() AS created_at,
               JSON_EXTRACT('{"value": 1}', '$.value') AS json_value,
               STRING_TO_VECTOR('[1, 2]') AS vector_value
        FROM values_table
      `),
      schema("9.7.2"),
    );
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.columns.map(({ name, tsType, databaseType, nullable, coercibility }) => ({
        name,
        tsType,
        databaseType,
        nullable,
        coercibility,
      })),
      [
        {
          name: "server_version",
          tsType: "string",
          databaseType: "varchar",
          nullable: false,
          coercibility: 3,
        },
        { name: "lowered", tsType: "string", databaseType: "varchar", nullable: false, coercibility: 2 },
        {
          name: "bytes_value",
          tsType: "Uint8Array",
          databaseType: "blob",
          nullable: false,
          coercibility: undefined,
        },
        {
          name: "created_at",
          tsType: "Date",
          databaseType: "datetime",
          nullable: false,
          coercibility: 5,
        },
        {
          name: "json_value",
          tsType: "unknown",
          databaseType: "json",
          nullable: true,
          coercibility: undefined,
        },
        {
          name: "vector_value",
          tsType: "Uint8Array",
          databaseType: "vector",
          nullable: false,
          coercibility: undefined,
        },
      ],
    );
  });
});
