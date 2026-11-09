import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSqlServerNativeContractAdapter,
  SqlServerContractAcquisitionError,
} from "@typed-sql/sqlserver/native-contracts";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { sqlserverProfile } from "@typed-sql/sqlserver/profile";
import {
  acquireNativeQueryContract,
  queryContractDigest,
} from "../../packages/analysis/dist/packages/analysis/src/index.js";
import { defaultSqlServerTypePolicy } from "../../packages/sqlserver/dist/packages/sqlserver/src/type-policy.js";
import { summarizeNativeDescriptorFacets } from "../../scripts/vocabulary/native-descriptor-facets.mjs";
import { reviewSqlServerDescriptors } from "../../scripts/vocabulary/sqlserver-descriptor-review.mjs";
import {
  sqlServerDescriptorCases,
  sqlServerDescriptorErrors,
  sqlServerDescriptorFailure,
} from "../../scripts/vocabulary/sqlserver-descriptors.mjs";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok([14, 15, 16, 17].includes(major));
const build = process.env.TYPED_SQL_SQLSERVER_BUILD;
assert.match(build ?? "", /^\d+\.\d+\.\d+\.\d+$/u);
const name = `typed_sql_descriptors_${major}_${randomBytes(6).toString("hex")}`;
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const profiles = [],
  failures = [];
let created = false;
const normalize = (value) =>
  typeof value === "string"
    ? value.replaceAll(name, "__owned_database")
    : Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, entry]) => entry !== undefined)
              .map(([key, entry]) => [key, normalize(entry)]),
          )
        : value;
const pool = {
  async acquire() {
    const database = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    return {
      all: (text, values) => database.queryable.all(text, values),
      release: () => database.close(),
      discard: () => database.close(),
    };
  },
};
const output = resolve(`../../artifacts/sqlserver/descriptors-${major}.json`);
const report = {
  formatVersion: 1,
  major,
  build,
  caseStatus: "incomplete",
  cleanupStatus: "pending",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  toolDigest: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  casesDigest: createHash("sha256")
    .update(await readFile(new URL("../../scripts/vocabulary/sqlserver-descriptors.mjs", import.meta.url)))
    .digest("hex"),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    odbcPackage: execFileSync("dpkg-query", ["--show", "msodbcsql18"], {
      encoding: "utf8",
    }).trim(),
  },
  policy: defaultSqlServerTypePolicy,
  method:
    "Live sys.types discovery, empty owned table declarations, bare casts and concrete modifier controls. Candidate text is passed as data to native metadata APIs; candidates are never executed or bound to sample values. A rejected bare/NULL/conversion witness is not a universal family verdict. Owned database names are normalized only for semantic fingerprints. Acquired evidence is not independent static/native qualification.",
  profiles,
};
const admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
try {
  assert.equal(admin.serverEvidence.version, build);
  await admin.queryable.all(`CREATE DATABASE [${name}]`);
  created = true;
  await admin.queryable.all(`ALTER DATABASE [${name}] SET QUERY_STORE=OFF`);
  for (const compatibility of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=${compatibility}`);
    const database = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    try {
      assert.equal(database.serverEvidence.version, build);
      assert.equal(database.serverEvidence.settings.compatibilityLevel, compatibility);
      const rows = await database.queryable.all(
        "SELECT TOP (1001) t.name,s.name AS namespace,t.system_type_id,t.user_type_id,t.is_user_defined,t.is_assembly_type,t.max_length,t.precision,t.scale,t.collation_name FROM sys.types t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.is_user_defined=0 ORDER BY t.name",
      );
      const { inventory, cases } = sqlServerDescriptorCases(rows);
      const declarations = [],
        probes = [],
        fields = {},
        observations = [],
        contextAttempts = [];
      const entry = {
        compatibility,
        server: database.serverEvidence,
        inventory,
        cases,
        declarations,
        contextAttempts,
        fields,
        observations,
      };
      profiles.push(entry);
      const schema = { formatVersion: 1, dialect: "sqlserver", tables: {}, server: database.serverEvidence };
      const adapter = createSqlServerNativeContractAdapter({ pool, schema, typePolicy: defaultSqlServerTypePolicy });
      entry.adapter = { id: adapter.id, version: adapter.version };
      entry.stage = "declarations";
      for (const [index, item] of cases.entries()) {
        entry.currentType = item.type;
        probes.push({
          origin: item.origin,
          type: item.type,
          mode: "column",
          sql: `SELECT CAST(NULL AS ${item.type}) AS value`,
        });
        probes.push({
          origin: item.origin,
          type: item.type,
          mode: "parameter",
          sql: `SELECT CAST(@__typed_sql_1 AS ${item.type}) AS value`,
        });
        if (item.origin !== "catalog") continue;
        const table = `descriptor_type_${index}`;
        try {
          await database.queryable.all(`CREATE TABLE dbo.${table} (value ${item.type})`);
          declarations.push({ type: item.type, status: "created", table });
          probes.push({
            origin: "catalog-table",
            type: item.type,
            mode: "column",
            sql: `SELECT value FROM dbo.${table}`,
          });
          probes.push({
            origin: "catalog-table",
            type: item.type,
            mode: "parameter",
            sql: `SELECT value FROM dbo.${table} WHERE value=@__typed_sql_1`,
          });
        } catch (error) {
          declarations.push({ type: item.type, ...sqlServerDescriptorFailure(error) });
        }
      }
      delete entry.currentType;
      entry.stage = "context";
      // Every target gets a new context after controlled DDL; no DDL interleaves acquisition.
      let context;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          context = await adapter.inspectContext();
          contextAttempts.push({ attempt, status: "observed" });
          break;
        } catch (error) {
          contextAttempts.push({ attempt, status: error.reason ?? "failed" });
          if (error.reason !== "context-changed" || attempt === 2) throw error;
        }
      }
      assert.ok(context);
      const store = ({ nativeType, runtimeType, nullable, descriptor }) => {
        const field = { nativeType, runtimeType, nullable, descriptor },
          identity = queryContractDigest(field);
        fields[identity] = field;
        return identity;
      };
      const raw = async (sql, parameter) => {
        let parameters = [],
          declaration = null;
        if (parameter) {
          try {
            parameters = await database.queryable.all("EXEC sys.sp_describe_undeclared_parameters @tsql = ?", [sql]);
          } catch (error) {
            return { ...sqlServerDescriptorFailure(error), stage: "parameters" };
          }
          if (parameters.length !== 1 || parameters[0].name !== "@__typed_sql_1")
            return { status: "unavailable", reason: "parameter-description-identity", parameters };
          const type = parameters[0].suggested_system_type_name;
          if (typeof type !== "string" || type.length > 512 || !/^[a-zA-Z0-9_ .,[\]()]+$/u.test(type))
            return { status: "unavailable", reason: "parameter-declaration-unavailable", parameters };
          declaration = `@__typed_sql_1 ${type}`;
        }
        let columns;
        try {
          columns = await database.queryable.all(
            "SELECT is_hidden,column_ordinal,name,is_nullable,system_type_id,system_type_name,max_length,precision,scale,collation_name,user_type_id,user_type_database,user_type_schema,user_type_name,assembly_qualified_type_name,xml_collection_id,xml_collection_database,xml_collection_schema,xml_collection_name,is_xml_document,is_case_sensitive,is_fixed_length_clr_type,error_number,error_type FROM sys.dm_exec_describe_first_result_set(?, ?, 0) ORDER BY column_ordinal",
            [sql, declaration],
          );
        } catch (error) {
          return { ...sqlServerDescriptorFailure(error), stage: "columns", parameters };
        }
        const errors = columns
          .filter(({ error_number }) => error_number != null)
          .map(({ error_number }) => Number(error_number));
        const shapeKnown =
          columns.length === 1 &&
          Number(columns[0].column_ordinal) === 1 &&
          columns[0].name === "value" &&
          [false, 0, "0"].includes(columns[0].is_hidden);
        return {
          ...(errors.length
            ? sqlServerDescriptorErrors(errors)
            : shapeKnown
              ? { status: "described" }
              : { status: "unavailable", reason: "result-description-shape" }),
          parameters,
          declaration,
          columns,
        };
      };
      entry.stage = "probes";
      for (const probe of probes) {
        entry.currentProbe = probe;
        const observation = { ...probe, independent: await raw(probe.sql, probe.mode === "parameter") };
        observations.push(observation);
        if (observation.independent.status !== "described") {
          observation.adapter = { status: "not-attempted", reason: `independent-${observation.independent.status}` };
          continue;
        }
        const candidate = {
          sql: probe.sql,
          parameterOccurrences: sqlserverProfile()
            .parameterOccurrences(probe.sql, schema)
            .map(({ index, range }) => ({ index, start: range.start, end: range.end })),
        };
        const admission = adapter.accept(candidate);
        if (!admission.accepted) {
          observation.adapter = { status: "declined", reason: admission.reason };
          continue;
        }
        let result;
        try {
          result = await acquireNativeQueryContract({ adapter, context, candidate });
        } catch (error) {
          if (error instanceof SqlServerContractAcquisitionError && error.reason === "unsupported-statement") {
            observation.adapter = { status: "unavailable", reason: "sqlserver-guarded-statement-scope" };
            continue;
          }
          const failure = adapter.classifyError(error);
          if (failure.kind !== "rejected" && failure.kind !== "partial") throw error;
          observation.adapter = { status: failure.kind, reason: failure.code };
          continue;
        }
        if (result.status !== "acquired") {
          observation.adapter = { status: result.status, reason: result.reason };
          continue;
        }
        assert.equal(
          observation.independent.status,
          "described",
          "Native acquisition must agree with independent metadata APIs",
        );
        const evidence = result.contract.nativeEvidence;
        assert.equal(evidence.columns.length, 1);
        assert.equal(evidence.parameters.length, probe.mode === "parameter" ? 1 : 0);
        assert.equal(observation.independent.columns.length, evidence.columns.length);
        for (const [values, independent, prefix] of [
          [evidence.columns, observation.independent.columns, ""],
          [evidence.parameters, observation.independent.parameters, "suggested_"],
        ])
          for (const [index, value] of values.entries()) {
            for (const [source, target] of [
              ["system_type_id", "systemTypeId"],
              ["user_type_id", "userTypeId"],
              ["max_length", "maxLength"],
              ["precision", "precision"],
              ["scale", "scale"],
              ["xml_collection_id", "xmlCollectionId"],
            ]) {
              const fact = independent[index][`${prefix}${source}`];
              assert.equal(value.descriptor[target], fact == null ? undefined : Number(fact));
            }
            const rawName = independent[index][`${prefix}system_type_name`];
            assert.equal(value.descriptor.systemTypeName, rawName == null ? undefined : rawName);
            if (!prefix) assert.equal(value.descriptor.collation, independent[index].collation_name ?? undefined);
          }
        observation.adapter = {
          status: "acquired",
          columns: evidence.columns.map(store),
          parameters: evidence.parameters.map(store),
        };
      }
      const counts = {};
      for (const observation of observations) {
        const key = `${observation.independent.status}/${observation.adapter.status}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      entry.counts = counts;
      entry.facets = summarizeNativeDescriptorFacets({ fields, observations });
      delete entry.currentProbe;
      entry.observationDigest = queryContractDigest(
        normalize({
          build,
          compatibility,
          server: entry.server,
          policy: defaultSqlServerTypePolicy,
          adapter: entry.adapter,
          inventory,
          cases,
          declarations,
          observations: observations.map(({ adapter, ...observation }) => ({
            ...observation,
            adapter: {
              ...adapter,
              columns: adapter.columns?.map((key) => fields[key]),
              parameters: adapter.parameters?.map((key) => fields[key]),
            },
          })),
        }),
      );
      assert.equal(observations.filter(({ origin }) => origin === "catalog").length, inventory.length * 2);
      assert.ok(observations.some(({ adapter }) => adapter.status === "acquired"));
      // Removing each table before changing compatibility avoids name collisions across targets.
      entry.stage = "table-cleanup";
      for (const declaration of declarations)
        if (declaration.status === "created") await database.queryable.all(`DROP TABLE dbo.${declaration.table}`);
      entry.stage = "complete";
    } finally {
      await database.close();
    }
  }
  report.caseStatus = "passed";
} catch (error) {
  failures.push(error);
}
const [cleanup] = await Promise.allSettled([
  (async () => {
    try {
      if (created) {
        await admin.queryable.all(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
        await admin.queryable.all(`DROP DATABASE [${name}]`);
      }
    } finally {
      await admin.close();
    }
  })(),
]);
report.cleanupStatus = cleanup.status === "fulfilled" ? "passed" : "failed";
if (cleanup.status === "rejected") failures.push(cleanup.reason);
if (process.argv.includes("--check")) {
  try {
    reviewSqlServerDescriptors(
      report,
      JSON.parse(
        await readFile(
          new URL("../../grammar/sqlserver/qualification/native-descriptors.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    report.reviewStatus = "passed";
  } catch (error) {
    report.reviewStatus = "failed";
    failures.push(error);
  }
} else report.reviewStatus = "not-requested";
await mkdir(resolve("../../artifacts/sqlserver"), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) throw new AggregateError(failures, "SQL Server descriptor observation or cleanup failed");
