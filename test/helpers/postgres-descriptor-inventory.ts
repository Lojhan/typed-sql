import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  type NativeContractValueEvidence,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import { postgres, postgresServerEvidence } from "../../packages/postgres/src/analysis.js";
import { createPgNativeContractAdapter } from "../../packages/postgres/src/pg-contracts.js";
import { describePgStatement, type PgProtocolDescription } from "../../packages/postgres/src/pg-description.js";
import { defaultPostgresTypePolicy } from "../../packages/postgres/src/type-policy.js";

interface CatalogType {
  oid: number;
  name: string;
  kind: string;
  category: string;
  element: number;
  modifier: boolean;
}
interface Observation {
  origin: "catalog-type" | "modifier-control";
  type: string;
  mode: "column" | "parameter";
  sql: string;
  protocol: { status: "described"; description: PgProtocolDescription } | { status: "rejected"; code: string };
  adapter: { status: string; reason?: string; columns?: string[]; parameters?: string[] };
}

/** Independent catalog discovery and Parse/Describe only: no Bind/Execute for candidates. */
export async function capturePostgresDescriptorInventory(
  pool: Pool,
  version: string,
  options: { reviewed?: boolean } = {},
) {
  const inventory = (
    await pool.query<CatalogType>(
      `SELECT t.oid, t.typname AS name, t.typtype AS kind, t.typcategory AS category,
        t.typelem AS element, t.typmodin <> 0 AS modifier
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='pg_catalog' AND t.oid < 16384 AND t.typisdefined AND t.typrelid=0
       ORDER BY t.typname LIMIT 2001`,
    )
  ).rows;
  strict.ok(inventory.length > 0 && inventory.length <= 2000);
  for (const type of inventory) {
    strict.ok(Number.isSafeInteger(type.oid) && type.oid > 0);
    strict.match(type.name, /^[a-z_][a-z_0-9]*$/u);
    strict.ok(typeof type.kind === "string" && type.kind.length === 1);
    strict.ok(typeof type.category === "string" && type.category.length === 1);
    strict.ok(Number.isSafeInteger(type.element) && type.element >= 0);
    strict.equal(typeof type.modifier, "boolean");
  }
  const schema = {
    formatVersion: 1 as const,
    dialect: "postgres" as const,
    server: postgresServerEvidence(version),
    tables: {},
  };
  const adapter = createPgNativeContractAdapter({ pool, schema });
  // Transport qualification is intentionally narrower than supported offline grammar versions.
  const qualifiedAdapter = /^18\./u.test(version);
  const fields: Record<string, NativeContractValueEvidence> = {};
  const observations: Observation[] = [];
  const store = ({ nativeType, runtimeType, nullable, descriptor }: NativeContractValueEvidence) => {
    const field = { nativeType, runtimeType, nullable, descriptor };
    const digest = queryContractDigest(field);
    fields[digest] = field;
    return digest;
  };
  const client = await pool.connect();
  try {
    const probe = async (type: string, origin: Observation["origin"], expectedOid?: number) => {
      for (const mode of ["column", "parameter"] as const) {
        const sql = `SELECT CAST(${mode === "column" ? "NULL" : "$1"} AS ${type}) AS value`;
        let protocol: Observation["protocol"];
        await client.query("BEGIN READ ONLY");
        try {
          await client.query("SET LOCAL statement_timeout = '2s'");
          const pending = describePgStatement(client, "", sql);
          if (!pending) throw new Error("PostgreSQL protocol description unavailable");
          const description = await pending;
          protocol = { status: "described", description };
        } catch (error) {
          const code = (error as { code?: string }).code;
          // Availability, timeouts and unexpected failures must fail the audit.
          if (!code || !/^(?:42|0A)[A-Z0-9]{3}$/u.test(code)) throw error;
          protocol = { status: "rejected", code };
        } finally {
          await client.query("ROLLBACK");
        }
        const observation: Observation = {
          origin,
          type,
          mode,
          sql,
          protocol,
          adapter: { status: "unavailable", reason: "engine-profile-not-qualified" },
        };
        observations.push(observation);
        if (protocol.status === "described") {
          strict.equal(protocol.description.columns.length, 1);
          strict.equal(protocol.description.parameters.length, mode === "parameter" ? 1 : 0);
          if (expectedOid !== undefined) {
            strict.equal(protocol.description.columns[0]!.dataTypeID, expectedOid);
            if (mode === "parameter") strict.equal(protocol.description.parameters[0], expectedOid);
          }
        }
        if (!qualifiedAdapter) continue;
        const candidate = {
          sql,
          parameterOccurrences: postgres().parameterOccurrences!(sql, schema).map(({ index, range }) => ({
            index,
            start: range.start,
            end: range.end,
          })),
        };
        const accepted = adapter.accept(candidate);
        if (!accepted.accepted) {
          observation.adapter = { status: "declined", reason: accepted.reason };
          continue;
        }
        let result: Awaited<ReturnType<typeof acquireNativeQueryContract>> | undefined;
        // Shared CI databases may receive unrelated WAL writes; retry only verified drift.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const context = await adapter.inspectContext();
            result = await acquireNativeQueryContract({ adapter, candidate, context });
            break;
          } catch (error) {
            const failure = adapter.classifyError?.(error);
            if (failure?.kind === "stale-context" && attempt < 2) continue;
            throw error;
          }
        }
        if (!result) throw new Error("No PostgreSQL descriptor observation");
        observation.adapter =
          result.status === "acquired"
            ? {
                status: result.status,
                columns: result.contract.nativeEvidence!.columns.map(store),
                parameters: result.contract.nativeEvidence!.parameters.map(store),
              }
            : { status: result.status, reason: result.reason };
        if (result.status !== "acquired") continue;
        strict.equal(protocol.status, "described", "Acquisition cannot contradict independent Parse/Describe");
        if (protocol.status !== "described") throw new Error("Contradictory PostgreSQL descriptors");
        const evidence = result.contract.nativeEvidence!;
        strict.equal(evidence.columns.length, 1);
        strict.equal(evidence.parameters.length, protocol.description.parameters.length);
        strict.equal(evidence.columns[0]!.descriptor.oid, protocol.description.columns[0]!.dataTypeID);
        strict.equal(evidence.columns[0]!.descriptor.typeModifier, protocol.description.columns[0]!.dataTypeModifier);
        strict.equal(evidence.columns[0]!.nullable.status, "unknown");
        for (const [index, parameter] of evidence.parameters.entries()) {
          strict.equal(parameter.descriptor.oid, protocol.description.parameters[index]);
          strict.equal(parameter.nullable.status, "unknown");
        }
      }
    };
    // Qualified internal identifiers preserve spelling and avoid user search-path aliases.
    for (const type of inventory)
      await probe(
        `pg_catalog.${type.name === "char" ? '"char"' : type.name}`,
        "catalog-type",
        type.kind === "p" ? undefined : type.oid,
      );
    // Modifier boundaries are distinct from a list of engine type names.
    for (const type of [
      "numeric(1,0)",
      "numeric(38,18)",
      "varchar(7)",
      "character(3)",
      "timestamp(3)",
      "interval day to second(2)",
    ])
      await probe(type, "modifier-control");
  } finally {
    client.release();
  }
  strict.equal(observations.filter(({ origin }) => origin === "catalog-type").length, inventory.length * 2);
  const counts: Record<string, number> = {};
  for (const observation of observations) {
    const key = `${observation.protocol.status}/${observation.adapter.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const report = {
    formatVersion: 1,
    engine: version,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      driverVersion: JSON.parse(await readFile(new URL("../../node_modules/pg/package.json", import.meta.url), "utf8"))
        .version as string,
    },
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    toolDigest: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    policy: defaultPostgresTypePolicy,
    adapter: { id: adapter.id, version: adapter.version, qualified: qualifiedAdapter },
    scope:
      "Defined bootstrap pg_catalog types (OID < 16384), excluding relation row types. Includes arrays, pseudo, range and multirange names. User/extension types and nondefault policies need separate qualification. Parse/Describe never executes candidate statements. Adapter acquisition is not independent semantic qualification.",
    inventory,
    fields,
    observations,
    counts,
    observationDigest: queryContractDigest({ inventory, fields, observations }),
  };
  const directory = process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `postgres-${version.split(" ")[0]}-descriptors.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  if (options.reviewed) {
    const approved = JSON.parse(
      await readFile(new URL("../../grammar/postgres/qualification/native-descriptors.json", import.meta.url), "utf8"),
    );
    strict.equal(approved.formatVersion, 1);
    const expected = approved.engines[version.split(" ")[0]!];
    strict.ok(expected, "Review the descriptor capture for this exact PostgreSQL engine before qualification");
    strict.equal(expected.catalogNames, inventory.length);
    strict.equal(expected.adapterQualified, qualifiedAdapter);
    strict.deepEqual(expected.counts, counts);
    strict.equal(
      expected.observationDigest,
      report.observationDigest,
      "Native PostgreSQL descriptor facts changed; review the capture without accepting new gaps",
    );
  }
  // Persist failures before checking the declared positive controls. Parameters deliberately
  // retain incomplete modifier identity: an OID does not encode precision, scale or length.
  for (const observation of observations.filter(({ origin }) => origin === "modifier-control")) {
    strict.equal(observation.protocol.status, "described");
    if (!qualifiedAdapter || observation.type.startsWith("interval ")) continue;
    strict.equal(observation.adapter.status, "acquired", observation.type);
    const column = fields[observation.adapter.columns![0]!]!;
    strict.equal(column.nativeType.status, "known");
    if (column.nativeType.status === "known") strict.equal(column.nativeType.value.complete, true);
    strict.equal(column.runtimeType.status, "known");
    for (const key of observation.adapter.parameters ?? []) {
      const parameter = fields[key]!;
      strict.equal(parameter.nativeType.status, "known");
      if (parameter.nativeType.status === "known") strict.equal(parameter.nativeType.value.complete, false);
      strict.equal(parameter.runtimeType.status, "known");
      strict.equal("typeModifier" in parameter.descriptor, false);
    }
  }
  return report;
}

if (process.argv[1] && (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))) {
  strict.ok(process.env.TYPED_SQL_POSTGRES_URL, "Set an explicit owned PostgreSQL audit URL");
  strict.ok(process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY, "Set an explicit descriptor capture directory");
  const pool = new Pool({ connectionString: process.env.TYPED_SQL_POSTGRES_URL, max: 2 });
  try {
    const version = (await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version"))
      .rows[0]!.version;
    const report = await capturePostgresDescriptorInventory(pool, version, {
      reviewed: process.argv.includes("--check"),
    });
    console.log(
      JSON.stringify({
        engine: report.engine,
        names: report.inventory.length,
        counts: report.counts,
        observationDigest: report.observationDigest,
      }),
    );
  } finally {
    await pool.end();
  }
}
