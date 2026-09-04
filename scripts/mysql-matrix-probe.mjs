import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPool } from "mysql2/promise";
import {
  MYSQL_SUPPORT_POLICY,
  mySqlCoreCatalog,
  mySqlVersionSupport,
  sql,
  typePolicy,
} from "../packages/mysql/dist/packages/mysql/src/index.js";
import { createMySql2Database } from "../packages/mysql/dist/packages/mysql/src/mysql2.js";

const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new TypeError(`Invalid argument ${name ?? "<missing>"}`);
  options[name.slice(2)] = value;
}
for (const required of [
  "channel",
  "connection-string",
  "expected-version",
  "label",
  "mode-profile",
  "output",
  "snapshot",
]) {
  if (typeof options[required] !== "string" || options[required].length === 0)
    throw new TypeError(`--${required} is required`);
}
if (options.channel !== "stable" && options.channel !== "canary")
  throw new TypeError("--channel must be stable or canary");

const modeProfile = MYSQL_SUPPORT_POLICY.sqlModeProfiles.find(({ name }) => name === options["mode-profile"]);
if (modeProfile === undefined) throw new TypeError("Unknown --mode-profile");

const connectionString = options["connection-string"];
const expectedVersion = options["expected-version"];
const expectedSeries = expectedVersion.split(".").slice(0, 2).join(".");
const catalog = mySqlCoreCatalog(expectedSeries);
if (catalog === undefined) throw new TypeError(`No committed MySQL ${expectedSeries} catalog exists`);

const hash = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const result = (id, pass, detail) => ({
  id,
  status: pass ? "pass" : "fail",
  ...(detail === undefined ? {} : { detail }),
});
const pool = createPool({
  uri: connectionString,
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  dateStrings: true,
  multipleStatements: false,
});
const results = [];
let artifact;

try {
  const snapshot = JSON.parse(await readFile(resolve(options.snapshot), "utf8"));
  const [serverRows] = await pool.query(`
    SELECT VERSION() AS version,
           @@version_comment AS version_comment,
           @@session.sql_mode AS sql_mode,
           @@global.character_set_server AS character_set_server,
           @@global.collation_server AS collation_server,
           @@session.character_set_connection AS character_set_connection,
           @@session.collation_connection AS collation_connection,
           @@session.time_zone AS time_zone,
           @@global.system_time_zone AS system_time_zone,
           @@global.lower_case_table_names AS lower_case_table_names
  `);
  const settings = serverRows[0];
  const actualVersion = String(settings.version);
  const actualModes = String(settings.sql_mode).split(",").filter(Boolean).sort();
  const actualSeries = actualVersion.split(".").slice(0, 2).join(".");
  results.push(
    result(
      "server.exact-patch",
      actualVersion.split("-")[0] === expectedVersion,
      `${expectedVersion} / ${actualVersion}`,
    ),
  );
  results.push(result("server.oracle-mysql", /mysql|source distribution/iu.test(String(settings.version_comment))));
  results.push(
    result("server.mode-profile", JSON.stringify(actualModes) === JSON.stringify(modeProfile.modes), {
      expected: modeProfile.modes,
      actual: actualModes,
    }),
  );
  results.push(result("snapshot.v2", snapshot.formatVersion === 2 && snapshot.dialect === "mysql"));
  results.push(result("snapshot.server-version", snapshot.server?.version === actualVersion));
  results.push(result("snapshot.sql-mode", snapshot.server?.settings?.sqlMode === actualModes.join(",")));
  results.push(
    result("catalog.revision", snapshot.extension?.attributes?.catalogRevision === catalog.revision, catalog.revision),
  );

  const [keywordRows] = await pool.query(
    "SELECT WORD AS word, RESERVED AS reserved FROM information_schema.KEYWORDS ORDER BY WORD",
  );
  const keywords = keywordRows.map(({ word, reserved }) => `${String(word).toLowerCase()}:${Number(reserved)}`);
  const [collationRows] = await pool.query(
    "SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS character_set FROM information_schema.COLLATIONS ORDER BY COLLATION_NAME",
  );
  const collations = collationRows.map(({ name, character_set }) => `${name}:${character_set}`);
  const liveCollationNames = new Set(collationRows.map(({ name }) => String(name).toLowerCase()));
  const missingCollations = catalog.collations
    .map(({ name }) => name)
    .filter((name) => !liveCollationNames.has(name.toLowerCase()));
  results.push(result("catalog.collations", missingCollations.length === 0, missingCollations));

  const syntaxProbes = [
    { id: "intersect", sql: "SELECT 1 AS value INTERSECT SELECT 1 AS value" },
    { id: "json-table", sql: "SELECT value FROM JSON_TABLE('[1]', '$[*]' COLUMNS (value INT PATH '$')) AS item" },
    {
      id: "lateral",
      sql: "SELECT item.value FROM (SELECT 1 AS id) AS source JOIN LATERAL (SELECT source.id AS value) AS item ON TRUE",
    },
    { id: "qualify", sql: "SELECT ROW_NUMBER() OVER () AS position_value QUALIFY position_value = 1" },
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
        code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
      });
    }
  }
  try {
    await pool.query("CREATE TEMPORARY TABLE typed_sql_matrix_vector (embedding VECTOR(3))");
    syntax.push({ id: "vector", accepted: true });
  } catch (error) {
    syntax.push({
      id: "vector",
      accepted: false,
      code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
    });
  } finally {
    await pool.query("DROP TEMPORARY TABLE IF EXISTS typed_sql_matrix_vector");
  }
  results.push(
    result(
      "syntax.supported-baseline",
      ["intersect", "json-table", "lateral"].every(
        (id) => syntax.find((probe) => probe.id === id)?.accepted === true,
      ) && syntax.find(({ id }) => id === "qualify")?.accepted === false,
      syntax,
    ),
  );
  results.push(
    result("syntax.vector-version", syntax.find(({ id }) => id === "vector")?.accepted === (actualSeries !== "8.4")),
  );

  const [quotedRows] = await pool.query('SELECT "id" AS value FROM users ORDER BY id LIMIT 1');
  const [pipeRows] = await pool.query("SELECT 'a' || 'b' AS value");
  const [escapeRows] = await pool.query("SELECT HEX('a\\nb') AS value");
  const lexical = options["mode-profile"] === "lexical";
  results.push(
    result("mode.ansi-quotes", lexical ? String(quotedRows[0]?.value) === "1" : quotedRows[0]?.value === "id"),
  );
  results.push(
    result("mode.pipes-as-concat", lexical ? pipeRows[0]?.value === "ab" : Number(pipeRows[0]?.value) === 0),
  );
  results.push(
    result(
      "mode.no-backslash-escapes",
      lexical ? escapeRows[0]?.value === "615C6E62" : escapeRows[0]?.value === "610A62",
    ),
  );

  let unsignedResult;
  try {
    const [rows] = await pool.query("SELECT CAST(0 AS UNSIGNED) - 1 AS value");
    unsignedResult = { accepted: true, value: String(rows[0]?.value) };
  } catch (error) {
    unsignedResult = {
      accepted: false,
      code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
    };
  }
  results.push(
    result(
      "mode.no-unsigned-subtraction",
      options["mode-profile"] === "numeric"
        ? unsignedResult.accepted && unsignedResult.value === "-1"
        : !unsignedResult.accepted,
      unsignedResult,
    ),
  );

  const [textRows, textFields] = await pool.query(
    "SELECT bigint_value, decimal_value, json_value, binary_value FROM codec_fidelity WHERE id = 1",
  );
  const [preparedRows, preparedFields] = await pool.execute(
    "SELECT bigint_value, decimal_value, json_value, binary_value FROM codec_fidelity WHERE id = ?",
    [1],
  );
  results.push(
    result(
      "protocol.text-prepared-parity",
      JSON.stringify(textRows) === JSON.stringify(preparedRows) &&
        JSON.stringify(textFields.map(({ name, columnType }) => [name, columnType])) ===
          JSON.stringify(preparedFields.map(({ name, columnType }) => [name, columnType])),
    ),
  );

  const warnings = [];
  const database = await createMySql2Database({
    connectionUri: connectionString,
    compatibilitySnapshot: snapshot,
    typePolicy,
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    const codecRows = await database.execute(sql`
      SELECT bigint_value, decimal_value, date_value, json_value, binary_value
      FROM codec_fidelity WHERE id = ${1}
    `);
    const codec = codecRows[0];
    results.push(
      result(
        "runtime.codec-parity",
        codec?.bigint_value === 9_007_199_254_740_993n &&
          codec?.decimal_value === "12345678901234567890.1234567890" &&
          codec?.date_value instanceof Date &&
          codec?.json_value?.kind === "json" &&
          codec?.binary_value instanceof Uint8Array,
      ),
    );
    await database.execute(sql`SELECT CAST(${"typed-sql-warning"} AS UNSIGNED) AS warning_value`);
    results.push(
      result(
        "runtime.warning-channel",
        warnings.length > 0 && warnings.every(({ fingerprint }) => /^sha256:[a-f0-9]{64}$/u.test(fingerprint)),
      ),
    );
    let multiStatementRejected = false;
    try {
      await database.execute(sql`${sql.raw("SELECT 1; SELECT 2")}`);
    } catch {
      multiStatementRejected = true;
    }
    results.push(result("runtime.multiple-statements-disabled", multiStatementRejected));
  } finally {
    await database.close();
  }

  const support = mySqlVersionSupport(actualVersion, options.channel);
  results.push(result("server.support-policy", support === "supported" || support === "canary", support));
  artifact = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    target: {
      label: options.label,
      channel: options.channel,
      modeProfile: options["mode-profile"],
      expectedVersion,
      actualVersion,
      actualSeries,
      support,
      driver: "mysql2",
      driverVersion: "3.24.3",
      runtime: "node",
      runtimeVersion: process.version,
    },
    evidence: {
      settings: {
        sqlMode: actualModes.join(","),
        characterSetServer: settings.character_set_server,
        collationServer: settings.collation_server,
        characterSetConnection: settings.character_set_connection,
        collationConnection: settings.collation_connection,
        timeZone: settings.time_zone,
        systemTimeZone: settings.system_time_zone,
        lowerCaseTableNames: Number(settings.lower_case_table_names),
      },
      snapshot: {
        formatVersion: snapshot.formatVersion,
        schemaHash: snapshot.metadata?.schemaHash,
        typePolicyHash: snapshot.metadata?.typePolicyHash,
        catalogRevision: snapshot.extension?.attributes?.catalogRevision,
      },
      catalog: {
        revision: catalog.revision,
        typeCount: catalog.types.length,
        coercionCount: catalog.coercions.length,
        routineCount: catalog.routines.reduce((count, family) => count + family.routines.length, 0),
        collationCount: catalog.collations.length,
        fingerprint: hash(catalog),
      },
      keywords: { count: keywords.length, fingerprint: hash(keywords), values: keywords },
      collations: { count: collations.length, fingerprint: hash(collations), values: collations },
      syntax,
      supportPolicy: MYSQL_SUPPORT_POLICY,
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
  throw new Error(`MySQL matrix target ${options.label} has ${artifact.summary.fail} differential failure(s)`);
process.stdout.write(
  `${artifact.target.actualVersion} ${artifact.target.modeProfile} ${artifact.summary.pass} probes\n`,
);
