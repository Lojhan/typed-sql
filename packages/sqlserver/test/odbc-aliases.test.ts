import { describe, it, strict } from "poku";
import { sqlServerOdbcField } from "../src/odbc.js";
import { sqlServerOdbcAliasRegistry } from "../src/odbc-aliases.js";

const row = { alias_schema: "dbo", alias_name: "alias", base_name: "bigint", max_length: 8, precision: 19, scale: 0 };
await describe("SQL Server attested native alias metadata", async () => {
  await it("matches independently captured underlying native families and dimensions", () => {
    for (const [base, length, precision, scale, code, size, expected] of [
      ["bigint", 8, 19, 0, -5, 19, "bigint"],
      ["decimal", 9, 20, 2, 3, 20, "decimal(20,2)"],
      ["nvarchar", 24, 0, 0, -9, 12, "nvarchar(12)"],
      ["varchar", -1, 0, 0, 12, 0, "varchar(max)"],
      ["binary", 8, 0, 0, -2, 8, "binary(8)"],
      ["time", 5, 16, 3, -154, 16, "time(3)"],
    ] as const) {
      const registry = sqlServerOdbcAliasRegistry([
        { ...row, base_name: base, max_length: String(length), precision, scale },
      ]);
      const raw = { name: "value", typeName: "alias", type: code, size, scale, nullable: false };
      strict.equal(sqlServerOdbcField(raw, registry).databaseType, expected);
      strict.equal(raw.typeName, "alias");
      strict.throws(() => sqlServerOdbcField({ ...raw, type: 999 }, registry), /family/);
      if (["nvarchar", "decimal", "time"].includes(base))
        strict.throws(() => sqlServerOdbcField({ ...raw, size: size + 1, scale: scale + 1 }, registry), /dimensions/);
    }
    const ambiguous = sqlServerOdbcAliasRegistry([row, { ...row, alias_schema: "other" }]);
    strict.throws(
      () =>
        sqlServerOdbcField({ name: "x", typeName: "alias", type: -5, size: 19, scale: 0, nullable: false }, ambiguous),
      /ambiguous/,
    );
    const fixed = sqlServerOdbcAliasRegistry([row]);
    for (const patch of [{ size: 18 }, { scale: 1 }])
      strict.throws(
        () =>
          sqlServerOdbcField(
            { name: "x", typeName: "alias", type: -5, size: 19, scale: 0, nullable: false, ...patch },
            fixed,
          ),
        /dimensions/,
      );
    const collision = sqlServerOdbcAliasRegistry([{ ...row, alias_name: "int" }]);
    strict.throws(
      () => sqlServerOdbcField({ name: "x", typeName: "int", type: 4, size: 10, scale: 0, nullable: false }, collision),
      /family/,
    );
    const unsupported = sqlServerOdbcAliasRegistry([{ ...row, base_name: "sql_variant" }]);
    strict.throws(
      () =>
        sqlServerOdbcField(
          { name: "x", typeName: "alias", type: -150, size: 0, scale: 0, nullable: false },
          unsupported,
        ),
      /ambiguous/,
    );
  });
  await it("rejects builtin-looking names whose independent wire family or fixed dimensions disagree", () => {
    for (const column of [
      { typeName: "bigint", type: 3, size: 20, scale: 0 },
      { typeName: "bigint", type: -5, size: 18, scale: 0 },
      { typeName: "bigint", type: -5, size: 19, scale: 1 },
      { typeName: "int", type: -9, size: 10, scale: 0 },
      { typeName: "varchar", type: -5, size: 19, scale: 0 },
      { typeName: "timestamp", type: -2, size: 9, scale: 0 },
      { typeName: "timestamp", type: -2, size: 8, scale: 1 },
    ])
      strict.throws(
        () => sqlServerOdbcField({ name: "value", nullable: false, ...column }, new Map()),
        /ODBC family|dimensions/,
      );
    strict.equal(
      sqlServerOdbcField(
        { name: "value", nullable: false, typeName: "bigint", type: -5, size: 19, scale: 0 },
        new Map(),
      ).databaseType,
      "bigint",
    );
  });
  await it("rejects invisible, malformed or unbounded alias evidence", () => {
    strict.throws(() => sqlServerOdbcAliasRegistry(Array.from({ length: 10001 }, () => row)), /bound/);
    for (const patch of [
      { alias_schema: null },
      { alias_schema: "" },
      { alias_schema: "x".repeat(129) },
      { alias_name: null },
      { alias_name: "" },
      { alias_name: "x".repeat(129) },
      { base_name: null },
      { max_length: "bad" },
      { max_length: Infinity },
      { precision: 1.5 },
      { precision: 18 },
      { scale: 1 },
      { scale: null },
      { base_name: "nvarchar", max_length: 3 },
    ])
      strict.throws(() => sqlServerOdbcAliasRegistry([{ ...row, ...patch }]));
    strict.throws(
      () =>
        sqlServerOdbcField(
          { name: "x", typeName: "invisible_alias", type: -5, size: 19, scale: 0, nullable: false },
          new Map(),
        ),
      /Unsupported/,
    );
  });
});
