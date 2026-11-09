import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  type NativeContractValueEvidence,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import { mysql2 } from "../../packages/mysql/src/mysql2.js";
import { createMySql2NativeContractAdapter } from "../../packages/mysql/src/mysql2-contracts.js";
import { tokenize } from "../../packages/mysql/src/parser/index.js";
import type { MySqlProtocolField } from "../../packages/mysql/src/protocol-fields.js";
import { MYSQL_SUPPORT_POLICY } from "../../packages/mysql/src/support.js";
import { defaultMySqlTypePolicy, isKnownMySqlType } from "../../packages/mysql/src/type-policy.js";

interface TypeCase {
  kind: "column" | "cast";
  type: string;
  alternatives: string[];
}
interface Observation {
  case: number;
  mode: "column" | "parameter";
  sql: string;
  protocol:
    | { status: "described"; columns: MySqlProtocolField[]; parameters: MySqlProtocolField[] }
    | { status: "rejected"; code: string };
  adapter: { status: string; reason?: string; columns?: string[]; parameters?: string[] };
}

/** Source-derived constructors; owned empty tables; COM_STMT_PREPARE without candidate execution. */
export async function captureMySqlDescriptorInventory(connectionUri: string) {
  const facts = JSON.parse(
    await readFile(new URL("../../grammar/mysql/qualification/descriptor-types.json", import.meta.url), "utf8"),
  ) as {
    inventories: Record<string, { alternatives: { id: string; symbols: string[] }[]; cases: TypeCase[] }>;
    profiles: {
      version: string;
      sourceDigest: string;
      factsDigest: string;
    }[];
  };
  const admin = await createConnection(connectionUri);
  const prefix = `typed_sql_descriptors_${randomBytes(6).toString("hex")}`;
  const tables: string[] = [];
  try {
    const [server] = await admin.query<RowDataPacket[]>("SELECT VERSION() AS version, @@session.sql_mode AS sqlMode");
    const engine = String(server[0]!.version),
      sqlMode = String(server[0]!.sqlMode);
    const reference = facts.profiles.find(({ version }) => version === engine);
    if (!reference) throw new Error(`Missing exact MySQL descriptor source profile: ${engine}`);
    const profile = { ...reference, ...facts.inventories[reference.factsDigest]! };
    const qualifiedAdapter = MYSQL_SUPPORT_POLICY.stable.some(({ matrixVersion }) => matrixVersion === engine);
    const columns: Record<string, unknown> = {};
    for (const [index, item] of profile.cases.entries()) {
      if (item.kind !== "column") continue;
      strict.match(item.type, /^[A-Z0-9_\s(),'a-z]+$/u);
      const table = `${prefix}_${index}`;
      await admin.query(`CREATE TABLE ${table} (value ${item.type}) ENGINE=InnoDB`);
      tables.push(table);
      const [metadata] = await admin.query<RowDataPacket[]>(
        "SELECT DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_OCTET_LENGTH,NUMERIC_PRECISION,NUMERIC_SCALE,DATETIME_PRECISION,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='value'",
        [table],
      );
      strict.equal(metadata.length, 1);
      columns[index] = { ...metadata[0] };
    }
    const schema = await mysql2({ connectionUri }).introspect();
    const adapter = createMySql2NativeContractAdapter({ connectionUri, schema });
    const context = qualifiedAdapter ? await adapter.inspectContext() : undefined;
    const fields: Record<string, NativeContractValueEvidence> = {};
    const observations: Observation[] = [];
    const store = ({ nativeType, runtimeType, nullable, descriptor }: NativeContractValueEvidence) => {
      const field = { nativeType, runtimeType, nullable, descriptor };
      const identity = queryContractDigest(field);
      fields[identity] = field;
      return identity;
    };
    const wire = (field: MySqlProtocolField): MySqlProtocolField => {
      const { name, columnType, flags, characterSet, columnLength, decimals } = field;
      if (typeof name !== "string" || typeof columnType !== "number" || typeof flags !== "number")
        throw new TypeError("Malformed MySQL wire name, type or flags");
      strict.ok([columnType, flags, characterSet, columnLength, decimals].every(Number.isSafeInteger));
      return {
        name,
        columnType: columnType!,
        flags,
        characterSet: characterSet!,
        columnLength: columnLength!,
        decimals: decimals!,
      };
    };
    for (const [index, item] of profile.cases.entries()) {
      for (const mode of ["column", "parameter"] as const) {
        const sql =
          item.kind === "column"
            ? `SELECT value FROM ${prefix}_${index}${mode === "parameter" ? " WHERE value = ?" : ""}`
            : `SELECT CAST(${mode === "parameter" ? "?" : "NULL"} AS ${item.type}) AS value`;
        let protocol: Observation["protocol"];
        try {
          const statement = await admin.prepare(sql);
          try {
            const native = (
              statement as unknown as { statement: { columns: MySqlProtocolField[]; parameters: MySqlProtocolField[] } }
            ).statement;
            strict.equal(native.columns.length, 1);
            strict.equal(native.parameters.length, mode === "parameter" ? 1 : 0);
            protocol = {
              status: "described",
              columns: native.columns.map(wire),
              parameters: native.parameters.map(wire),
            };
          } finally {
            await statement.close();
          }
        } catch (error) {
          const detail = error as { code?: string; sqlState?: string };
          // Statement diagnostics are evidence; infrastructure/authentication failures must stop.
          if (!detail.code || !detail.sqlState || !/^(?:22|42)/u.test(detail.sqlState)) throw error;
          protocol = { status: "rejected", code: detail.code };
        }
        const observation: Observation = {
          case: index,
          mode,
          sql,
          protocol,
          adapter: { status: "unavailable", reason: "engine-profile-not-qualified" },
        };
        observations.push(observation);
        if (!context) continue;
        const candidate = {
          sql,
          parameterOccurrences: tokenize(sql, { sqlMode })
            .filter(({ kind }) => kind === "parameter")
            .map((token) => ({ index: Number(token.value), start: token.range.start, end: token.range.end })),
        };
        const admission = adapter.accept(candidate);
        if (!admission.accepted) {
          observation.adapter = { status: "declined", reason: admission.reason };
          continue;
        }
        let result: Awaited<ReturnType<typeof acquireNativeQueryContract>>;
        try {
          result = await acquireNativeQueryContract({ adapter, context, candidate });
        } catch (error) {
          const failure = adapter.classifyError?.(error);
          if (failure?.kind !== "rejected" && failure?.kind !== "partial") throw error;
          observation.adapter = { status: failure.kind, reason: failure.code };
          continue;
        }
        if (result.status !== "acquired") {
          observation.adapter = { status: result.status, reason: result.reason };
          continue;
        }
        strict.equal(protocol.status, "described", "Native acquisition must agree with independent preparation");
        if (protocol.status !== "described") throw new Error("Contradictory MySQL protocol evidence");
        const evidence = result.contract.nativeEvidence!;
        strict.equal(evidence.columns.length, protocol.columns.length);
        strict.equal(evidence.parameters.length, protocol.parameters.length);
        for (const [values, independent] of [
          [evidence.columns, protocol.columns],
          [evidence.parameters, protocol.parameters],
        ] as const)
          for (const [position, value] of values.entries()) {
            const expected = independent[position]!;
            strict.deepEqual(value.descriptor, {
              type: expected.columnType,
              flags: expected.flags,
              characterSet: expected.characterSet,
              columnLength: expected.columnLength,
              decimals: expected.decimals,
            });
          }
        for (const parameter of evidence.parameters) strict.equal(parameter.nullable.status, "unknown");
        observation.adapter = {
          status: "acquired",
          columns: evidence.columns.map(store),
          parameters: evidence.parameters.map(store),
        };
      }
    }
    const counts: Record<string, number> = {};
    for (const observation of observations) {
      const key = `${observation.protocol.status}/${observation.adapter.status}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const rawTypePolicyRecognition = profile.cases
      .filter(({ kind }) => kind === "column")
      .map(({ type }) => ({ type, known: isKnownMySqlType(type, schema) }));
    const report = {
      formatVersion: 1,
      engine,
      sqlMode,
      environment: { node: process.version, platform: process.platform, architecture: process.arch },
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      toolDigest: createHash("sha256")
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest("hex"),
      policy: defaultMySqlTypePolicy,
      adapter: { id: adapter.id, version: adapter.version, qualified: qualifiedAdapter },
      sourceProfile: { version: profile.version, sourceDigest: profile.sourceDigest, factsDigest: profile.factsDigest },
      alternatives: profile.alternatives,
      cases: profile.cases,
      columnMetadata: columns,
      rawTypePolicyRecognition,
      fields,
      observations,
      counts,
      method:
        "Bounded witnesses for every pinned column/cast grammar alternative, expanding lexical aliases. Owned empty InnoDB tables provide independent column metadata. COM_STMT_PREPARE and guarded native acquisition never execute candidates or bind sample values. A rejected NULL/cast witness does not prove a whole type family unsupported. Numeric/dimension/enum/spatial/JSON facets may remain partial or unavailable. Raw type-policy checks are not parser/analyzer coverage. SQL mode is recorded; owned table prefixes alone are normalized in the semantic digest.",
      observationDigest: queryContractDigest({
        sqlMode,
        cases: profile.cases,
        columns,
        rawTypePolicyRecognition,
        fields,
        observations: observations.map((item) => ({
          ...item,
          sql: item.sql.replaceAll(prefix, "__owned_descriptors"),
        })),
      }),
    };
    const output = process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY;
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, `mysql-${engine}-${queryContractDigest(sqlMode).slice(0, 12)}-descriptors.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    strict.equal(observations.length, profile.cases.length * 2);
    strict.ok(observations.some(({ adapter }) => adapter.status === "acquired") || !qualifiedAdapter);
    return report;
  } finally {
    try {
      for (const table of tables.reverse()) await admin.query(`DROP TABLE ${table}`);
    } finally {
      await admin.end();
    }
  }
}

if (process.argv[1] && (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))) {
  strict.ok(process.env.TYPED_SQL_MYSQL_URL, "Set an explicit owned MySQL audit URL");
  strict.ok(process.env.TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY, "Set an explicit descriptor capture directory");
  const report = await captureMySqlDescriptorInventory(process.env.TYPED_SQL_MYSQL_URL!);
  console.log(
    JSON.stringify({
      engine: report.engine,
      cases: report.cases.length,
      counts: report.counts,
      observationDigest: report.observationDigest,
    }),
  );
}
