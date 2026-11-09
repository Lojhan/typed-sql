import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { acquireNativeQueryContract, type NativeContractValueEvidence, queryContractDigest } from "@typed-sql/analysis";
import { strict } from "poku";
import { createNodeSqliteNativeContractAdapter } from "../../src/node-sqlite-contracts.js";
import { sqliteProfile } from "../../src/profile.js";
import { defaultSqliteTypePolicy, isKnownStrictSqliteType, type SqliteTypePolicy } from "../../src/type-policy.js";

interface Probe {
  readonly origin:
    | "standard-strict"
    | "standard-flexible"
    | "standard-cast"
    | "constraint-control"
    | "arbitrary-declaration"
    | "expression";
  readonly sql: string;
  readonly declaredType: string | null;
  readonly notNull?: true;
}

/** Source-derived standard names plus live declared/expression metadata, never sampled row values. */
export async function captureSqliteDescriptorInventory() {
  const facts = JSON.parse(
    await readFile(new URL("../../../../grammar/sqlite/qualification/descriptor-types.json", import.meta.url), "utf8"),
  ) as {
    inventories: Record<string, { name: string; affinity: string }[]>;
    profiles: [string, string, string][];
  };
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-descriptors-"));
  const path = join(directory, "descriptors.sqlite");
  const database = new DatabaseSync(path);
  try {
    const engine = String(database.prepare("SELECT sqlite_version() AS version").get()!.version);
    const sourceId = String(database.prepare("SELECT sqlite_source_id() AS source").get()!.source);
    const sourceProfile = facts.profiles.find(([version]) => version === engine);
    // No nearest-version substitution can certify the complete source inventory.
    if (!sourceProfile) throw new Error(`Missing exact SQLite descriptor source profile: ${engine}`);
    const inventory = facts.inventories[sourceProfile[2]]!;
    strict.equal(`sha256:${createHash("sha256").update(JSON.stringify(inventory)).digest("hex")}`, sourceProfile[2]);
    for (const type of inventory) {
      strict.equal(isKnownStrictSqliteType(type.name), true, `Missing offline standard type: ${type.name}`);
      strict.equal(isKnownStrictSqliteType(type.name.toLowerCase()), true);
    }
    const probes: Probe[] = [];
    for (const [index, type] of inventory.entries()) {
      strict.match(type.name, /^[A-Z][A-Z0-9_]*$/u);
      for (const strictTable of [true, false]) {
        const table = `type_${strictTable ? "strict" : "flexible"}_${index}`;
        database.exec(`CREATE TABLE ${table} (value ${type.name})${strictTable ? " STRICT" : ""}`);
        probes.push({
          origin: strictTable ? "standard-strict" : "standard-flexible",
          sql: `SELECT value FROM ${table}`,
          declaredType: type.name,
        });
      }
      probes.push({ origin: "standard-cast", sql: `SELECT CAST(? AS ${type.name}) AS value`, declaredType: null });
    }
    const integerType = inventory.find(({ affinity }) => affinity === "INTEGER");
    strict.ok(integerType, "Nullability controls require a discovered integer declaration");
    for (const strictTable of [true, false]) {
      const table = `nonnull_${strictTable ? "strict" : "flexible"}`;
      database.exec(`CREATE TABLE ${table} (value ${integerType!.name} NOT NULL)${strictTable ? " STRICT" : ""}`);
      probes.push({
        origin: "constraint-control",
        sql: `SELECT value FROM ${table}`,
        declaredType: integerType!.name,
        notNull: true,
      });
    }
    // SQLite's ordinary declaration space is open. These are class controls, not an exhaustive alias list.
    for (const [index, declaration] of ["DECIMAL(12,2)", "VARCHAR(9)", '"opaque tag"', ""].entries()) {
      const table = `arbitrary_${index}`;
      database.exec(`CREATE TABLE ${table} (value ${declaration})`);
      probes.push({
        origin: "arbitrary-declaration",
        sql: `SELECT value FROM ${table}`,
        declaredType: declaration ? declaration.replaceAll('"', "") : null,
      });
    }
    for (const sql of [
      "SELECT NULL AS value",
      "SELECT ? AS value",
      "SELECT CASE WHEN ? THEN 1 ELSE 'x' END AS value",
      "SELECT json_object('key', ?) AS value",
    ])
      probes.push({ origin: "expression", sql, declaredType: null });
    const schema = { formatVersion: 1 as const, dialect: "sqlite" as const, tables: {} };
    const fields: Record<string, NativeContractValueEvidence> = {};
    const observations: {
      policy: string;
      probe: number;
      status: "acquired" | "unavailable";
      reason?: string;
      columns?: string[];
      parameters?: string[];
    }[] = [];
    const nativeColumns = probes.map(({ sql, declaredType }) => {
      const statement = database.prepare(sql);
      try {
        const columns = statement.columns();
        strict.equal(columns.length, 1);
        strict.equal(columns[0]!.type, declaredType);
        return columns;
      } finally {
        if ("close" in statement && typeof statement.close === "function") statement.close();
      }
    });
    const policies: Record<string, SqliteTypePolicy> = {
      default: defaultSqliteTypePolicy,
      number: { ...defaultSqliteTypePolicy, integer: "number" },
      unknown: { ...defaultSqliteTypePolicy, flexible: "unknown" },
      parsedJson: { ...defaultSqliteTypePolicy, json: "parsed" },
    };
    const store = ({ nativeType, runtimeType, nullable, descriptor }: NativeContractValueEvidence) => {
      const field = { nativeType, runtimeType, nullable, descriptor };
      const digest = queryContractDigest(field);
      fields[digest] = field;
      return digest;
    };
    for (const [policy, typePolicy] of Object.entries(policies)) {
      const adapter = createNodeSqliteNativeContractAdapter({ path, schema, typePolicy });
      const context = await adapter.inspectContext();
      for (const [probe, { sql }] of probes.entries()) {
        const parameterOccurrences = sqliteProfile().parameterOccurrences!(sql, schema).map(({ index, range }) => ({
          index,
          start: range.start,
          end: range.end,
        }));
        const result = await acquireNativeQueryContract({ adapter, context, candidate: { sql, parameterOccurrences } });
        if (typePolicy.flexible === "unknown" && parameterOccurrences.length > 0) {
          strict.deepEqual(result, { status: "unavailable", reason: "parameter-metadata-unavailable" });
          observations.push({ policy, probe, status: "unavailable", reason: "parameter-metadata-unavailable" });
          continue;
        }
        strict.equal(result.status, "acquired", `${policy}: ${sql}`);
        if (result.status !== "acquired") throw new Error("SQLite descriptor control did not acquire");
        const evidence = result.contract.nativeEvidence!;
        strict.equal(evidence.columns.length, 1);
        strict.equal(evidence.parameters.length, parameterOccurrences.length);
        strict.deepEqual(evidence.columns[0]!.descriptor.origin, { ...nativeColumns[probe]![0]! });
        for (const [parameter, values] of [
          [false, evidence.columns],
          [true, evidence.parameters],
        ] as const) {
          for (const field of values) {
            strict.deepEqual(field.nativeType, {
              status: "known",
              value: { name: "sqlite-storage-class", complete: false },
            });
            strict.deepEqual(field.nullable, { status: "known", value: true, precision: "upper-bound" });
            strict.deepEqual(field.runtimeType, {
              status: "known",
              value:
                typePolicy.flexible === "unknown"
                  ? "unknown"
                  : {
                      union: [
                        ...new Set([
                          typePolicy.integer,
                          "number",
                          "string",
                          "bytes",
                          ...(parameter ? ["boolean"] : []),
                        ]),
                      ],
                    },
            });
          }
        }
        observations.push({
          policy,
          probe,
          status: "acquired",
          columns: evidence.columns.map(store),
          parameters: evidence.parameters.map(store),
        });
      }
    }
    const report = {
      formatVersion: 1,
      engine,
      sourceId,
      environment: { node: process.version, platform: process.platform, architecture: process.arch },
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      toolDigest: createHash("sha256")
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest("hex"),
      sourceProfile,
      inventory,
      policies,
      probes,
      nativeColumns,
      fields,
      observations,
      counts: {
        standardNames: inventory.length,
        probes: probes.length,
        policies: Object.keys(policies).length,
        acquired: observations.filter(({ status }) => status === "acquired").length,
        unavailable: observations.filter(({ status }) => status === "unavailable").length,
      },
      method:
        "Pinned engine standard-name tables plus owned empty strict/flexible tables, open-declaration and expression controls. Candidates are prepared without stepping or parameter binding. Native origin declarations do not prove an exact storage class, expression result type, JSON shape or non-nullability. Even strict table columns retain incomplete storage-domain identity under the current native adapter.",
      observationDigest: queryContractDigest({ inventory, policies, probes, nativeColumns, fields, observations }),
    };
    const output = process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY;
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, `sqlite-${engine}-node-${process.versions.node.split(".")[0]}-descriptors.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    return report;
  } finally {
    try {
      database.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
