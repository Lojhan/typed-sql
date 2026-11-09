import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as SDK from "@duckdb/node-api";
import { acquireNativeQueryContract, type NativeContractValueEvidence, queryContractDigest } from "@typed-sql/analysis";
import { strict as assert } from "poku";
import { summarizeNativeDescriptorFacets } from "../../../../scripts/vocabulary/native-descriptor-facets.mjs";
import { type DuckDBType, formatDuckDBType, parseDuckDBType } from "../../src/native-types.js";
import { createNodeDuckDBNativeContractAdapter } from "../../src/node-api-contracts.js";
import { duckDBParameterOccurrences } from "../../src/parser/parser.js";
import { duckdbProfile } from "../../src/profile.js";
import { DUCKDB_SUPPORT_POLICY } from "../../src/support-policy.js";
import { defaultDuckDBTypePolicy, duckDBRuntimeType } from "../../src/type-policy.js";

interface Observation {
  readonly origin: "catalog-bare-type" | "constructed-control";
  readonly type: string;
  readonly mode: "column" | "parameter";
  readonly sql: string;
  status: string;
  reason?: string;
  columns?: readonly string[];
  parameters?: readonly string[];
}

/** Discover engine names independently; do not turn a bare parametric name into a concrete type. */
export async function captureDuckDBDescriptorInventory(sdk: Pick<typeof SDK, "DuckDBInstance" | "version">) {
  const engine = DUCKDB_SUPPORT_POLICY.qualifiedEngines.find((engine) => sdk.version() === `v${engine}`);
  if (!engine) throw new TypeError("Unqualified DuckDB descriptor engine");
  const sdkPackage = process.env.TYPED_SQL_DUCKDB_SDK_PACKAGE ?? "@duckdb/node-api";
  const sdkMetadata = JSON.parse(
    await readFile(new URL(`../../node_modules/${sdkPackage}/package.json`, import.meta.url), "utf8"),
  );
  assert.equal(sdkMetadata.name, "@duckdb/node-api");
  assert.equal(sdkMetadata.version, DUCKDB_SUPPORT_POLICY.nodeApi[engine]);
  const instance = await sdk.DuckDBInstance.create(":memory:", {
    enable_external_access: "false",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
  });
  let connection: SDK.DuckDBConnection | undefined;
  const types = new Map<
    string,
    { name: string; logicalType: string; category: string | null; locations: { database: string; schema: string }[] }
  >();
  try {
    connection = await instance.connect();
    const result = await connection.run(
      "SELECT database_name,schema_name,type_name,logical_type,type_category FROM system.main.duckdb_types() WHERE internal ORDER BY type_name,database_name,schema_name LIMIT 10001",
    );
    try {
      const rows = await result.getRows();
      assert.ok(rows.length > 0 && rows.length <= 10000);
      for (const [database, schema, name, logicalType, category] of rows) {
        if (
          typeof database !== "string" ||
          typeof schema !== "string" ||
          typeof name !== "string" ||
          typeof logicalType !== "string" ||
          (category !== null && typeof category !== "string")
        )
          throw new TypeError("DuckDB type inventory has malformed names or classification metadata");
        let entry = types.get(name);
        if (!entry) {
          entry = { name, logicalType, category, locations: [] };
          types.set(name, entry);
        }
        assert.equal(entry.logicalType, logicalType, "Repeated internal names must have the same logical type");
        assert.equal(entry.category, category, "Repeated internal names must have the same category");
        entry.locations.push({ database, schema });
      }
    } finally {
      result.closeSync();
    }
  } finally {
    try {
      connection?.closeSync();
    } finally {
      instance.closeSync();
    }
  }
  const inventory = [...types.values()];
  const schema = { formatVersion: 1 as const, dialect: "duckdb" as const, tables: {} };
  const adapter = createNodeDuckDBNativeContractAdapter({ path: ":memory:", schema, sdkImporter: async () => sdk });
  const context = await adapter.inspectContext();
  const fields: Record<string, NativeContractValueEvidence> = {};
  const observations: Observation[] = [];
  const store = ({ nativeType, runtimeType, nullable, descriptor }: NativeContractValueEvidence) => {
    const field = { nativeType, runtimeType, nullable, descriptor };
    const digest = queryContractDigest(field);
    fields[digest] = field;
    return digest;
  };
  const probe = async (type: string, mode: Observation["mode"], origin: Observation["origin"], expression: string) => {
    const sql = `SELECT ${expression} AS value`;
    const candidate = {
      sql,
      parameterOccurrences: duckDBParameterOccurrences(sql).map(({ index, range }) => ({
        index,
        start: range.start,
        end: range.end,
      })),
    };
    const admission = adapter.accept(candidate);
    const observation: Observation = { origin, type, mode, sql, status: "declined" };
    observations.push(observation);
    if (!admission.accepted) {
      observation.reason = admission.reason;
      return observation;
    }
    let acquired: Awaited<ReturnType<typeof acquireNativeQueryContract>>;
    try {
      acquired = await acquireNativeQueryContract({ adapter, candidate, context });
    } catch (error) {
      const failure = adapter.classifyError?.(error);
      if (!failure) throw error;
      observation.status = failure.kind;
      observation.reason = failure.code;
      return observation;
    }
    observation.status = acquired.status;
    if (acquired.status !== "acquired") {
      observation.reason = acquired.reason;
      return observation;
    }
    const evidence = acquired.contract.nativeEvidence;
    if (!evidence) throw new TypeError("An acquired descriptor probe has no native evidence");
    assert.equal(evidence.columns.length, 1);
    assert.equal(evidence.parameters.length, mode === "column" ? 0 : 1);
    observation.columns = evidence.columns.map(store);
    observation.parameters = evidence.parameters.map(store);
    return observation;
  };
  for (const type of inventory)
    for (const mode of ["column", "parameter"] as const)
      await probe(
        type.name,
        mode,
        "catalog-bare-type",
        `CAST(${mode === "column" ? "NULL" : "$1"} AS ${duckdbProfile().quoteIdentifier(type.name)})`,
      );

  // Concrete structural controls complement discovery; this is not a list of engine scalar names.
  const controls: Record<DuckDBType["kind"], readonly string[]> = {
    scalar: ["DECIMAL(1,0)", "DECIMAL(38,38)"],
    enum: ["ENUM('first','second')"],
    list: ["INTEGER[]"],
    array: ["INTEGER[2]"],
    struct: ["STRUCT(id BIGINT, label VARCHAR)", "STRUCT(items BIGINT[], pairs MAP(VARCHAR,INTEGER[]))"],
    map: ["MAP(INTEGER,VARCHAR)"],
    union: ["UNION(n INTEGER,s VARCHAR)"],
    tuple: ["TUPLE(INTEGER,VARCHAR)"],
  };
  const requiredControls: { type: string; inputType: string; observation: Observation }[] = [];
  for (const [kind, declarations] of Object.entries(controls))
    for (const type of declarations) {
      assert.equal(parseDuckDBType(type).kind, kind, "Every modeled kind needs a matching concrete control");
      for (const mode of ["column", "parameter"] as const) {
        const observation = await probe(
          type,
          mode,
          "constructed-control",
          kind === "tuple"
            ? `row(CAST(${mode === "column" ? "NULL" : "$1"} AS INTEGER),CAST(NULL AS VARCHAR))`
            : `CAST(${mode === "column" ? "NULL" : "$1"} AS ${type})`,
        );
        requiredControls.push({ type, inputType: kind === "tuple" ? "INTEGER" : type, observation });
      }
    }
  assert.equal(observations.filter(({ origin }) => origin === "catalog-bare-type").length, inventory.length * 2);
  const counts: Record<string, number> = {};
  for (const observation of observations) counts[observation.status] = (counts[observation.status] ?? 0) + 1;
  const report = {
    facets: summarizeNativeDescriptorFacets({ fields, observations }),
    formatVersion: 1,
    engine: sdk.version(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      sdkPackage,
      sdkVersion: DUCKDB_SUPPORT_POLICY.nodeApi[engine],
    },
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    toolDigest: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    policy: defaultDuckDBTypePolicy,
    adapter: { id: adapter.id, version: adapter.version },
    method:
      "Native catalog discovery plus guarded NULL/typed-parameter preparation. No candidate execution, parameter binding or sample application values. Bare parametric/pseudo names may need concrete declarations; their decline is not evidence that every member of that family is unsupported. Acquired descriptors are observations, not independent static/native qualification or universal family coverage. Nullability remains unknown.",
    inventory,
    fields,
    observations,
    counts,
    observationDigest: queryContractDigest({
      inventory: inventory.map(({ locations: _locations, ...type }) => type),
      fields,
      observations,
    }),
  };
  const directory = process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `duckdb-${sdk.version().replace(/^v/u, "")}-descriptors.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  // Persist every observed failure before asserting declared structural capabilities.
  for (const { type, inputType, observation } of requiredControls) {
    assert.equal(observation.status, "acquired", `${type}: ${observation.reason}`);
    const field = fields[observation.columns![0]!]!;
    const model = parseDuckDBType(type);
    assert.deepEqual(field.runtimeType, {
      status: "known",
      value: duckDBRuntimeType(model, defaultDuckDBTypePolicy),
    });
    assert.deepEqual(field.nativeType, { status: "known", value: { name: formatDuckDBType(model), complete: true } });
    assert.deepEqual(field.descriptor.logicalType, model);
    assert.equal(field.nullable.status, "unknown");
    if (observation.mode === "parameter") {
      const parameter = fields[observation.parameters![0]!]!;
      const parameterModel = parseDuckDBType(inputType);
      assert.deepEqual(parameter.runtimeType, {
        status: "known",
        value: duckDBRuntimeType(parameterModel, defaultDuckDBTypePolicy),
      });
      assert.deepEqual(parameter.nativeType, {
        status: "known",
        value: { name: formatDuckDBType(parameterModel), complete: true },
      });
      assert.deepEqual(parameter.descriptor.logicalType, parameterModel);
      assert.equal(parameter.nullable.status, "unknown");
    }
  }
  return report;
}

if (process.argv[1] && (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))) {
  assert.ok(process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY, "Set an explicit descriptor capture directory");
  const sdk = await import(process.env.TYPED_SQL_DUCKDB_SDK_PACKAGE ?? "@duckdb/node-api");
  assert.equal(sdk.version(), process.env.TYPED_SQL_DUCKDB_EXPECTED_ENGINE);
  const report = await captureDuckDBDescriptorInventory(sdk);
  console.log(
    JSON.stringify({
      engine: report.engine,
      names: report.inventory.length,
      counts: report.counts,
      observationDigest: report.observationDigest,
    }),
  );
}
