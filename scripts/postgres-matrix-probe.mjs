import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import {
  POSTGRES_SUPPORT_POLICY,
  postgresCoreCatalog,
  postgresVersionSupport,
  sql,
  typePolicy,
} from "../packages/postgres/dist/packages/postgres/src/index.js";
import { createPgDatabase } from "../packages/postgres/dist/packages/postgres/src/pg.js";

const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new TypeError(`Invalid argument ${name ?? "<missing>"}`);
  options[name.slice(2)] = value;
}
for (const required of ["connection-string", "expected-version", "label", "output", "snapshot"]) {
  if (typeof options[required] !== "string" || options[required].length === 0)
    throw new TypeError(`--${required} is required`);
}
if (options.channel !== "stable" && options.channel !== "canary")
  throw new TypeError("--channel must be stable or canary");

const connectionString = options["connection-string"];
const expectedVersion = options["expected-version"];
const expectedMajor = Number.parseInt(expectedVersion, 10);
const catalog = postgresCoreCatalog(expectedMajor);
if (catalog === undefined) throw new TypeError(`No committed PostgreSQL ${expectedMajor} catalog exists`);

const hash = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const result = (id, pass, detail) => ({
  id,
  status: pass ? "pass" : "fail",
  ...(detail === undefined ? {} : { detail }),
});
const pool = new Pool({ connectionString });
const results = [];
let artifact;

try {
  const snapshotSource = await readFile(resolve(options.snapshot), "utf8");
  const snapshot = JSON.parse(snapshotSource);
  const server = await pool.query(`
    SELECT current_setting('server_version') AS version,
           current_setting('server_version_num') AS version_num,
           current_setting('search_path') AS search_path,
           current_setting('standard_conforming_strings') AS standard_conforming_strings
  `);
  const settings = server.rows[0];
  const actualVersion = String(settings.version);
  const actualMajor = Math.trunc(Number(settings.version_num) / 10_000);
  results.push(
    result("server.exact-minor", actualVersion.startsWith(expectedVersion), `${expectedVersion} / ${actualVersion}`),
  );
  results.push(result("snapshot.v2", snapshot.formatVersion === 2 && snapshot.dialect === "postgres"));
  results.push(result("snapshot.server-version", String(snapshot.server?.version ?? "") === actualVersion));
  results.push(
    result(
      "snapshot.semantic-settings",
      snapshot.server?.settings?.standardConformingStrings === settings.standard_conforming_strings &&
        snapshot.server?.settings?.searchPath === settings.search_path,
    ),
  );
  results.push(
    result("catalog.revision", snapshot.extension?.attributes?.catalogRevision === catalog.revision, catalog.revision),
  );

  const keywords = (await pool.query("SELECT word, catcode FROM pg_get_keywords() ORDER BY word")).rows.map(
    ({ word, catcode }) => `${word}:${catcode}`,
  );
  const installedExtensions = (
    await pool.query(`
      SELECT name || ':' || version AS identity
      FROM pg_available_extension_versions
      WHERE installed
      ORDER BY name, version
    `)
  ).rows.map(({ identity }) => identity);
  const typeNames = catalog.types.map(({ name }) => name);
  const typeEvidence = await pool.query(
    `SELECT requested, to_regtype(requested)::text AS resolved
     FROM unnest($1::text[]) AS requested
     ORDER BY requested`,
    [typeNames],
  );
  const missingTypes = typeEvidence.rows.filter(({ resolved }) => resolved === null).map(({ requested }) => requested);
  results.push(result("catalog.types", missingTypes.length === 0, missingTypes));

  const castEvidence = await pool.query(
    `WITH requested AS (
       SELECT source, target
       FROM jsonb_to_recordset($1::jsonb) AS item(source text, target text)
     )
     SELECT requested.source, requested.target
     FROM requested
     LEFT JOIN pg_cast
       ON castsource = to_regtype(requested.source)
      AND casttarget = to_regtype(requested.target)
     WHERE pg_cast.oid IS NULL
     ORDER BY requested.source, requested.target`,
    [JSON.stringify(catalog.casts)],
  );
  const missingCasts = castEvidence.rows.map(({ source, target }) => `${source}>${target}`);
  results.push(result("catalog.casts", missingCasts.length === 0, missingCasts));

  const operatorNames = [
    ...new Set(
      catalog.operators
        .flatMap(({ operators }) => operators)
        .filter((name) => !/[A-Za-z\s]/u.test(name) && name !== "!="),
    ),
  ].sort();
  const liveOperators = (
    await pool.query(
      `SELECT DISTINCT oprname AS name
       FROM pg_operator
       WHERE oprnamespace = 'pg_catalog'::regnamespace AND oprname = ANY($1::text[])
       ORDER BY oprname`,
      [operatorNames],
    )
  ).rows.map(({ name }) => name);
  const missingOperators = operatorNames.filter((name) => !liveOperators.includes(name));
  results.push(result("catalog.operators", missingOperators.length === 0, missingOperators));

  const routineNames = [
    ...new Set([...catalog.routines, ...catalog.tableRoutines].flatMap(({ routines }) => routines)),
  ].sort();
  const liveRoutines = (
    await pool.query(
      `SELECT DISTINCT proname AS name
       FROM pg_proc
       WHERE pronamespace = 'pg_catalog'::regnamespace AND upper(proname) = ANY($1::text[])
       ORDER BY proname`,
      [routineNames],
    )
  ).rows.map(({ name }) => name.toUpperCase());

  const syntaxProbes = [
    { id: "with-materialized", sql: "WITH value AS MATERIALIZED (SELECT 1 AS id) SELECT id FROM value" },
    {
      id: "merge",
      sql: "MERGE INTO users AS target USING (SELECT -1::bigint AS id) AS source ON target.id = source.id WHEN NOT MATCHED THEN DO NOTHING",
    },
    { id: "sql-json-object", sql: "SELECT JSON_OBJECT('value': 1)" },
    {
      id: "json-table",
      sql: "SELECT value FROM JSON_TABLE('[1]'::jsonb, '$[*]' COLUMNS (value integer PATH '$'))",
    },
  ];
  const syntax = [];
  for (const probe of syntaxProbes) {
    try {
      await pool.query(probe.sql);
      syntax.push({ id: probe.id, accepted: true });
    } catch (error) {
      syntax.push({
        id: probe.id,
        accepted: false,
        sqlstate: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
      });
    }
  }
  const merge = syntax.find(({ id }) => id === "merge");
  results.push(result("syntax.merge-version", merge?.accepted === actualMajor >= 15, merge));

  const database = await createPgDatabase({
    connectionString,
    compatibilitySnapshot: resolve(options.snapshot),
    typePolicy,
  });
  try {
    const codecRows = await database.execute(sql`
      SELECT 2147483647::int4 AS integer_value,
             9007199254740993::int8 AS bigint_value,
             1.25::numeric AS numeric_value,
             true::boolean AS boolean_value,
             '{"value":1}'::jsonb AS json_value,
             decode('00a5ff', 'hex') AS binary_value
    `);
    const codec = codecRows[0];
    results.push(
      result(
        "runtime.codec-parity",
        codec?.integer_value === 2_147_483_647 &&
          codec?.bigint_value === 9_007_199_254_740_993n &&
          codec?.numeric_value === "1.25" &&
          codec?.boolean_value === true &&
          codec?.json_value?.value === 1 &&
          codec?.binary_value instanceof Uint8Array &&
          codec.binary_value.length === 3,
      ),
    );
  } finally {
    await database.close();
  }

  const support = postgresVersionSupport(actualVersion, options.channel);
  results.push(result("server.support-policy", support === options.channel || support === "supported", support));
  artifact = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    target: {
      label: options.label,
      channel: options.channel,
      expectedVersion,
      actualVersion,
      actualMajor,
      support,
      driver: "pg",
      driverVersion: "8.23.0",
      runtime: "node",
      runtimeVersion: process.version,
    },
    evidence: {
      settings: {
        searchPath: settings.search_path,
        standardConformingStrings: settings.standard_conforming_strings,
      },
      installedExtensions,
      snapshot: {
        formatVersion: snapshot.formatVersion,
        schemaHash: snapshot.metadata?.schemaHash,
        typePolicyHash: snapshot.metadata?.typePolicyHash,
        catalogRevision: snapshot.extension?.attributes?.catalogRevision,
      },
      catalog: {
        revision: catalog.revision,
        typeCount: catalog.types.length,
        castCount: catalog.casts.length,
        operatorFamilies: catalog.operators.map(({ name, operators }) => ({ name, operators })),
        routineNames,
        liveRoutineNames: liveRoutines,
        fingerprint: hash(catalog),
      },
      keywords: { count: keywords.length, fingerprint: hash(keywords), values: keywords },
      syntax,
      supportPolicy: POSTGRES_SUPPORT_POLICY,
    },
    results,
    summary: {
      pass: results.filter(({ status }) => status === "pass").length,
      fail: results.filter(({ status }) => status === "fail").length,
    },
  };
} finally {
  await pool.end();
}

const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
if (artifact.summary.fail > 0)
  throw new Error(`PostgreSQL matrix target ${options.label} has ${artifact.summary.fail} differential failure(s)`);
process.stdout.write(`${artifact.target.actualVersion} ${artifact.target.support} ${artifact.summary.pass} probes\n`);
