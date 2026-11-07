import { readdir, readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import type { ResolvedParameter } from "../../packages/core/src/index.js";
import { compareNativeDescription } from "../../scripts/language-audit/description.js";
import type {
  NativeDescription,
  NativeDescriptionMapper,
  NativeTypeDescriptor,
} from "../../scripts/language-audit/native-description/contracts.js";
import {
  createNativeDescriptionRegistry,
  nativeDescriptionRegistry,
} from "../../scripts/language-audit/native-description/index.js";
import { postgresDescription } from "../../scripts/language-audit/native-description/postgres.js";

const analyzed = (databaseType: string, parameters: ResolvedParameter[] = []) => ({
  columns: [
    { name: "value", databaseType, tsType: "number", nullable: true, range: { start: 0, end: 1, line: 1, column: 1 } },
  ],
  parameters,
  diagnostics: [],
});
const metadata = (descriptor: NativeTypeDescriptor): NativeDescription => ({
  columns: [descriptor],
  parameterCount: 0,
});
const prepared = (descriptor: NativeTypeDescriptor) => ({ accepted: true, metadata: metadata(descriptor) });
const integer = { nativeType: "integer", engineType: 23, typeModifier: -1 };

await describe("independent native type-description comparison", async () => {
  await it("keeps native unmodified identities separate from SQL declaration defaults", () => {
    strict.equal(postgresDescription.claimSql("bit"), "SELECT CAST(NULL AS pg_catalog.bit) AS value");
    strict.equal(postgresDescription.claimSql("character"), "SELECT CAST(NULL AS pg_catalog.bpchar) AS value");
    strict.equal(postgresDescription.claimSql("bit(3)"), "SELECT CAST(NULL AS bit(3)) AS value");
    strict.equal(postgresDescription.claimSql("character(30)"), "SELECT CAST(NULL AS character(30)) AS value");
  });
  await it("resolves aliases through the engine and retains independent claim evidence", async () => {
    const queries: string[] = [];
    const oracle = nativeDescriptionRegistry.create("postgres", async (sql) => {
      queries.push(sql);
      return prepared(integer);
    });
    const result = await compareNativeDescription(metadata(integer), analyzed("int4"), oracle);
    strict.equal(result.status, "native-identities-match");
    strict.deepEqual(queries, ["SELECT CAST(NULL AS int4) AS value"]);
    strict.deepEqual(result.claims[0]?.nativeClaim, integer);
    await compareNativeDescription(metadata(integer), analyzed("int4"), oracle);
    strict.equal(queries.length, 1, "An oracle caches per connection and exact type spelling");
  });

  await it("detects wrong logical identities and PostgreSQL modifiers without a host parser", async () => {
    const oracle = nativeDescriptionRegistry.create("postgres", async () => prepared(integer));
    strict.equal(
      (
        await compareNativeDescription(
          metadata({ ...integer, engineType: 25, nativeType: "text" }),
          analyzed("int4"),
          oracle,
        )
      ).status,
      "mismatch",
    );
    const varchar = { nativeType: "character varying", engineType: 1043, typeModifier: 34 };
    const varcharOracle = nativeDescriptionRegistry.create("postgres", async () => prepared(varchar));
    const modifier = await compareNativeDescription(
      metadata({ ...varchar, typeModifier: 54 }),
      analyzed("varchar(30)"),
      varcharOracle,
    );
    strict.equal(modifier.status, "mismatch");
    strict.equal(modifier.claims[0]?.expectedIdentity, "[1043,54]");
    strict.equal(modifier.claims[0]?.claimedIdentity, "[1043,34]");
  });

  await it("compares parameter OIDs separately and never qualifies missing parameter evidence", async () => {
    const parameters = [{ index: 1, tsType: "number", nullable: true, databaseType: "integer" }];
    const oracle = nativeDescriptionRegistry.create("postgres", async () => prepared(integer));
    const native = { ...metadata(integer), parameterCount: 1 };
    strict.equal(
      (await compareNativeDescription(native, analyzed("integer", parameters), oracle)).status,
      "unverified",
    );
    const complete = { ...native, parameters: [{ index: 1, engineType: 23 }] };
    strict.equal(
      (await compareNativeDescription(complete, analyzed("integer", parameters), oracle)).status,
      "native-identities-match",
    );
    complete.parameters[0]!.engineType = 25;
    strict.equal(
      (await compareNativeDescription(complete, analyzed("integer", parameters), oracle)).status,
      "mismatch",
    );
  });

  await it("keeps SQL Server logical spelling and dimensions distinct from storage IDs", async () => {
    const descriptor = {
      engineType: 165,
      nativeType: "varbinary(12)",
      maxLength: 12,
      precision: 0,
      scale: 0,
      userTypeSchema: null,
      userTypeName: null,
    };
    const oracle = nativeDescriptionRegistry.create("sqlserver", async () => prepared(descriptor));
    const vector = { ...descriptor, nativeType: "vector(3)" };
    strict.equal(
      (await compareNativeDescription(metadata(vector), analyzed("varbinary(12)"), oracle)).status,
      "mismatch",
    );
    const larger = { ...descriptor, maxLength: 20, nativeType: "varbinary(20)" };
    strict.equal(
      (await compareNativeDescription(metadata(larger), analyzed("varbinary(12)"), oracle)).status,
      "mismatch",
    );
    strict.equal(
      (
        await compareNativeDescription(
          metadata({ ...descriptor, userTypeName: "custom" }),
          analyzed("varbinary(12)"),
          oracle,
        )
      ).status,
      "mismatch",
    );
  });

  await it("preserves DuckDB branding and nested descriptors", async () => {
    const descriptor = {
      engineType: 17,
      nativeType: "JSON[]",
      nativeTypeStructure: { child: { alias: "JSON", typeId: 17 }, typeId: 24 },
    };
    const oracle = nativeDescriptionRegistry.create("duckdb", async () => prepared(descriptor));
    strict.equal(
      (await compareNativeDescription(metadata(descriptor), analyzed("JSON[]"), oracle)).status,
      "native-identities-match",
    );
    const unbranded = {
      ...descriptor,
      nativeType: "VARCHAR[]",
      nativeTypeStructure: { child: { typeId: 17 }, typeId: 24 },
    };
    strict.equal((await compareNativeDescription(metadata(unbranded), analyzed("JSON[]"), oracle)).status, "mismatch");
  });

  await it("leaves unavailable or rejected descriptions unverified and propagates infrastructure failures", async () => {
    const rejected = nativeDescriptionRegistry.create("postgres", async () => ({
      accepted: false,
      reason: "type not found",
    }));
    const result = await compareNativeDescription(metadata(integer), analyzed("unsupported"), rejected);
    strict.equal(result.status, "unverified");
    strict.equal(result.claims[0]?.reason, "type not found");
    strict.equal(
      (await compareNativeDescription(metadata(integer), analyzed("integer"), undefined)).status,
      "unverified",
    );
    const missingModifier = nativeDescriptionRegistry.create("postgres", async () => prepared({ engineType: 23 }));
    strict.equal(
      (await compareNativeDescription(metadata(integer), analyzed("integer"), missingModifier)).status,
      "unverified",
    );
    const failed = nativeDescriptionRegistry.create("postgres", async () => {
      throw new Error("connection lost");
    });
    await strict.rejects(compareNativeDescription(metadata(integer), analyzed("integer"), failed), /connection lost/u);
  });

  await it("accepts external owners and rejects conflicting registrations and structural claims", async () => {
    const mapper: NativeDescriptionMapper = {
      id: "external-graph",
      claimSql: (type) => `DESCRIBE TYPE ${type}`,
      identity: (descriptor) => descriptor.nativeType ?? undefined,
    };
    strict.throws(() => createNativeDescriptionRegistry([mapper, mapper]), /Duplicate/u);
    const registry = createNativeDescriptionRegistry([mapper]);
    strict.equal(
      registry.create("unknown", async () => prepared(integer)),
      undefined,
    );
    const queries: string[] = [];
    const oracle = registry.create(mapper.id, async (sql) => {
      queries.push(sql);
      return prepared({ nativeType: "graph_node" });
    });
    strict.equal(
      (await compareNativeDescription(metadata({ nativeType: "graph_node" }), analyzed("graph_node"), oracle)).status,
      "native-identities-match",
    );
    for (const type of ["int;SELECT 1", "int--comment", "int/*comment*/", "\u0000", " "])
      strict.equal((await compareNativeDescription(metadata(integer), analyzed(type), oracle)).status, "unverified");
    strict.deepEqual(queries, ["DESCRIBE TYPE graph_node"]);
  });

  await it("keeps the expected-side dependency boundary independent of grammar implementations", async () => {
    const files = [
      "description.ts",
      ...(
        await readdir(new URL("../../scripts/language-audit/native-description/", import.meta.url), { recursive: true })
      )
        .filter((name) => /\.[cm]?[jt]s$/u.test(name))
        .map((name) => `native-description/${name}`),
    ];
    for (const file of files) {
      const source = await readFile(new URL(`../../scripts/language-audit/${file}`, import.meta.url), "utf8");
      strict.doesNotMatch(source, /packages\/(?!core\/)/u, file);
    }
  });
});
