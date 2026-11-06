import type { JsonShape } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { sqlserver } from "../src/browser.js";
import { snapshot } from "./helpers/maturity-corpus.js";

const grammar = sqlserver();
const parsed = { ...grammar.defaultTypePolicy, json: "parsed" as const };
function analyze(expression: string) {
  const result = grammar.analyze(`SELECT ${expression} AS value FROM dbo.widgets`, snapshot, parsed);
  strict.deepEqual(result.diagnostics, [], expression);
  return result.columns[0]!;
}
function property(shape: JsonShape | undefined, key: string): JsonShape | undefined {
  strict.equal(shape?.kind, "object");
  return shape?.kind === "object" ? shape.properties[key]?.shape : undefined;
}

// Constructors serialize native SQL values independently of scalar application codecs.
// Money constructor NUMBER evidence: native run42126193484 (SQL17compat140), unlike FOR JSON conversion docs.
// https://learn.microsoft.com/en-us/sql/relational-databases/json/how-for-json-converts-sql-server-data-types-to-json-data-types-sql-server
await describe("SQL Server JSON serialization and fragment provenance", async () => {
  await it("uses native numeric JSON values under exact string decimal and bigint policies", () => {
    const result = analyze("JSON_OBJECT('amount':amount,'id':id,'flag':active)");
    strict.equal(result.tsType, '{ "amount": number; "id": number; "flag": boolean; }');
    for (const name of ["amount", "id"]) strict.deepEqual(property(result.json?.shape, name), { kind: "number" });
    strict.deepEqual(property(result.json?.shape, "flag"), { kind: "boolean" });
  });
  await it("serializes money as a JSON number and bytes/temporal values as JSON strings", () => {
    const result = analyze(
      "JSON_OBJECT('money':CAST(amount AS money),'bytes':CAST(0x00FF AS varbinary(2)),'time':CAST('12:34:56.1234567' AS time(7)),'date':CAST('2026-01-01' AS date))",
    );
    strict.deepEqual(property(result.json?.shape, "money"), { kind: "number" });
    for (const key of ["bytes", "time", "date"])
      strict.deepEqual(property(result.json?.shape, key), { kind: "string" });
  });
  await it("embeds direct constructor objects while ordinary text remains escaped text", () => {
    const result = analyze("JSON_OBJECT('nested':JSON_OBJECT('id':id),'text':N'{\"id\":1}')");
    strict.equal(property(result.json?.shape, "nested")?.kind, "object");
    strict.deepEqual(property(result.json?.shape, "text"), { kind: "string" });
  });
  await it("includes SQL NULL when a nullable JSON fragment is embedded", () => {
    const result = analyze("JSON_OBJECT('nested':JSON_QUERY(JSON_OBJECT('id':id)))");
    const nested = property(result.json?.shape, "nested");
    strict.equal(nested?.kind, "union");
    if (nested?.kind === "union") strict.ok(nested.variants.some((shape) => shape.kind === "null"));
    strict.deepEqual(property(analyze("JSON_OBJECT('nothing':NULL)").json?.shape, "nothing"), { kind: "null" });
  });
  await it("does not invent fragment provenance through CASE or COALESCE text expressions", () => {
    for (const expression of [
      "CASE WHEN active=1 THEN JSON_OBJECT('id':id) ELSE JSON_OBJECT('quantity':quantity) END",
      "COALESCE(JSON_OBJECT('id':id),JSON_OBJECT('quantity':quantity))",
    ]) {
      const combined = analyze(expression);
      strict.equal(combined.json?.shape.kind, "union");
      const embedded = analyze(`JSON_OBJECT('nested':${expression})`);
      strict.deepEqual(property(embedded.json?.shape, "nested"), { kind: "unknown" });
    }
    const nullAlternative = analyze("COALESCE(NULL,JSON_OBJECT('id':id))");
    strict.equal(nullAlternative.json?.shape.kind, "object");
    strict.notEqual(nullAlternative.tsType, "null");
  });
  await it("keeps declared JSON storage text separate from JSON_QUERY promotion", () => {
    const declared = {
      ...snapshot,
      tables: {
        ...snapshot.tables,
        widgets: {
          ...snapshot.tables.widgets,
          columns: {
            ...snapshot.tables.widgets.columns,
            document: {
              ...snapshot.tables.widgets.columns.document!,
              jsonDeclaration: {
                source: "application" as const,
                shape: { kind: "object" as const, properties: { id: { shape: { kind: "number" as const } } } },
              },
            },
          },
        },
      },
    };
    for (const [expression, kind] of [
      ["document", "string"],
      ["JSON_QUERY(document)", "union"],
    ] as const) {
      const result = grammar.analyze(
        `SELECT JSON_OBJECT('nested':${expression}) AS value FROM dbo.widgets`,
        declared,
        parsed,
      );
      strict.deepEqual(result.diagnostics, []);
      strict.equal(property(result.columns[0]?.json?.shape, "nested")?.kind, kind);
    }
  });
  await it("declines unsupported XML and opaque JSON serialization before claiming a shape", () => {
    const result = grammar.analyze("SELECT JSON_OBJECT('payload':payload) AS value FROM dbo.widgets", snapshot, parsed);
    strict.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSQ201"));
    strict.equal(result.semantics?.operation.value, "unknown");
  });
});
