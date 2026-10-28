import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep the original SQLite commands reproducible while sharing measurement code.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("RUNTIME_BENCHMARK_") && process.env[name.replace("RUNTIME_", "SQLITE_")] === undefined)
    process.env[name.replace("RUNTIME_", "SQLITE_")] = value;
}
const driver =
  process.env.RUNTIME_BENCHMARK_DRIVER ?? (process.argv[2] === "--worker" ? "sqlite" : (process.argv[2] ?? "sqlite"));
if (!["sqlite", "postgres", "mysql"].includes(driver)) throw new TypeError("Expected sqlite, postgres, or mysql");
const DatabaseSync = driver === "sqlite" ? (await import("node:sqlite")).DatabaseSync : undefined;
const policy = { integer: "number", flexible: "union", unknown: "unknown" };
const selectedPolicy = (candidate) => (candidate.includes("-parsed") ? { ...policy, json: "parsed" } : policy);
const candidates = [
  "raw-cached",
  "raw-prepare",
  "typed-inline",
  "typed-prepared",
  "typed-file",
  "typed-file-prepared",
  "typed-file-parsed",
  "typed-file-parsed-prepared",
  "typed-compiled-inline",
  "typed-compiled-prepared",
  "reylo-file",
  "reylo-sync",
];
const workloads = {
  point: { sql: "SELECT id, email, status FROM account WHERE id = ?", width: 1 },
  multirow: { sql: "SELECT id, email, status FROM account WHERE id BETWEEN ? AND ? ORDER BY id", width: 32 },
  json: {
    sql: "SELECT json_group_array(json_object('id', id, 'email', email, 'status', status)) AS items FROM account WHERE id BETWEEN ? AND ?",
    width: 32,
  },
};
if (driver !== "sqlite") {
  const first = driver === "postgres" ? "$1" : "?";
  const last = driver === "postgres" ? "$2" : "?";
  workloads.point.sql = `SELECT id, email, status FROM runtime_account WHERE id = ${first}`;
  workloads.multirow.sql = `SELECT id, email, status FROM runtime_account WHERE id BETWEEN ${first} AND ${last} ORDER BY id`;
  const aggregate = driver === "postgres" ? "jsonb_agg" : "JSON_ARRAYAGG";
  const object = driver === "postgres" ? "jsonb_build_object" : "JSON_OBJECT";
  workloads.json.sql = `SELECT ${aggregate}(${object}('id', id, 'email', email, 'status', status)) AS items FROM runtime_account WHERE id BETWEEN ${first} AND ${last}`;
}
const databaseUrl = () =>
  driver === "postgres"
    ? (process.env.POSTGRES_URL ?? "postgresql://typed_sql:typed_sql@127.0.0.1:55432/typed_sql_benchmark")
    : (process.env.MYSQL_URL ?? "mysql://typed_sql:typed_sql@127.0.0.1:53306/typed_sql_benchmark");

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function selected(name, available) {
  const values = process.env[name]?.split(",") ?? available;
  if (values.length === 0 || values.some((value) => !available.includes(value))) throw new TypeError(`Invalid ${name}`);
  return values;
}

function parameters(index, width) {
  const first = (index % (1_001 - width)) + 1;
  return width === 1 ? [first] : [first, first + width - 1];
}

function normalize(value, workload) {
  if (workload === "multirow") return value;
  const row = Array.isArray(value) ? value[0] : value;
  return workload === "json" ? { items: typeof row.items === "string" ? JSON.parse(row.items) : row.items } : row;
}

function check(value, index, workload) {
  const { width } = workloads[workload];
  const first = parameters(index, width)[0];
  const rows =
    workload === "point" ? [value] : workload === "json" ? [...value.items].sort((a, b) => a.id - b.id) : value;
  assert.equal(rows.length, width);
  for (const [offset, row] of rows.entries()) {
    assert.equal(row.id, first + offset);
    assert.equal(row.email, `person-${first + offset}@example.com`);
    assert.equal(row.status, "active");
  }
}

async function worker(candidate, workload, concurrency) {
  let database;
  if (driver === "sqlite") database = new DatabaseSync("app.db");
  else if (candidate.startsWith("raw") || candidate.startsWith("reylo")) {
    if (driver === "postgres") {
      const { default: pg } = await import("pg");
      database = new pg.Pool({ connectionString: databaseUrl(), max: 10 });
    } else {
      const { default: mysql } = await import("mysql2/promise");
      database = mysql.createPool({ uri: databaseUrl(), connectionLimit: 10 });
    }
  }
  const { sql: text, width } = workloads[workload];
  let typed;
  let run;
  if (candidate.startsWith("raw")) {
    if (driver === "sqlite") {
      const statement = candidate === "raw-cached" ? database.prepare(text) : undefined;
      run = (values) => (statement ?? database.prepare(text)).all(...values);
    } else if (driver === "postgres") {
      run = (values) =>
        database
          .query({ text, values, ...(candidate === "raw-cached" ? { name: "runtime-comparison" } : {}) })
          .then((result) => result.rows);
    } else
      run = (values) =>
        database[candidate === "raw-cached" ? "execute" : "query"](text, values).then((result) => result[0]);
  } else if (candidate.startsWith("reylo")) {
    const { default: query } = await import(pathToFileURL(resolve("query.sql")).href);
    run = (values) =>
      query[candidate === "reylo-sync" ? "runSync" : "run"](
        database,
        values.length === 1 ? { 1: values[0] } : { 1: values[0], 2: values[1] },
      );
  } else {
    const { sql } = await import(`@typed-sql/${driver}`);
    if (driver === "sqlite") {
      const { adaptNodeSqliteDatabase } = await import("@typed-sql/sqlite/node-sqlite");
      const { createSqliteDatabase } = await import("@typed-sql/sqlite/runtime");
      const typePolicy = selectedPolicy(candidate);
      typed = createSqliteDatabase({
        connection: adaptNodeSqliteDatabase(database, { typePolicy }),
        typePolicy,
        ownsConnection: false,
      });
    } else if (driver === "postgres") {
      const { createPgDatabase } = await import("@typed-sql/postgres/pg");
      typed = await createPgDatabase({ connectionString: databaseUrl(), poolConfig: { max: 10 } });
    } else {
      const { createMySql2Database } = await import("@typed-sql/mysql/mysql2");
      typed = await createMySql2Database({ connectionUri: databaseUrl(), poolConfig: { connectionLimit: 10 } });
    }
    let factory;
    if (candidate.startsWith("typed-file")) factory = (await import(pathToFileURL(resolve("query.sql")).href)).default;
    else if (candidate.startsWith("typed-compiled"))
      factory = (await import(pathToFileURL(resolve("compiled.ts")).href)).default;
    else if (driver !== "sqlite") {
      if (workload === "point") factory = (id) => sql`SELECT id, email, status FROM runtime_account WHERE id = ${id}`;
      else if (workload === "multirow")
        factory = (first, last) =>
          sql`SELECT id, email, status FROM runtime_account WHERE id BETWEEN ${first} AND ${last} ORDER BY id`;
      else if (driver === "postgres")
        factory = (first, last) =>
          sql`SELECT jsonb_agg(jsonb_build_object('id', id, 'email', email, 'status', status)) AS items FROM runtime_account WHERE id BETWEEN ${first} AND ${last}`;
      else
        factory = (first, last) =>
          sql`SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'email', email, 'status', status)) AS items FROM runtime_account WHERE id BETWEEN ${first} AND ${last}`;
    } else if (workload === "point") factory = (id) => sql`SELECT id, email, status FROM account WHERE id = ${id}`;
    else if (workload === "multirow")
      factory = (first, last) =>
        sql`SELECT id, email, status FROM account WHERE id BETWEEN ${first} AND ${last} ORDER BY id`;
    else
      factory = (first, last) =>
        sql`SELECT json_group_array(json_object('id', id, 'email', email, 'status', status)) AS items FROM account WHERE id BETWEEN ${first} AND ${last}`;
    if (candidate.endsWith("prepared")) factory = typed.prepare("comparison-query", factory);
    run = (values) => typed[workload === "multirow" ? "all" : "maybeOne"](factory(...values));
  }
  const operation = async (index) => normalize(await run(parameters(index, width)), workload);
  try {
    const start = performance.now();
    const first = await operation(511);
    const firstCallMilliseconds = performance.now() - start;
    check(first, 511, workload);
    console.log(JSON.stringify({ phase: "first", firstCallMilliseconds }));
    const warmups = integer("SQLITE_BENCHMARK_WARMUPS", 500);
    const samples = integer("SQLITE_BENCHMARK_SAMPLES", 20);
    const iterations = integer("SQLITE_BENCHMARK_ITERATIONS", 2_000);
    async function batch(count) {
      let last;
      if (concurrency === 1) for (let index = 0; index < count; index++) last = await operation(index);
      else
        for (let index = 0; index < count; index += concurrency) {
          const size = Math.min(concurrency, count - index);
          const values = await Promise.all(Array.from({ length: size }, (_, offset) => operation(index + offset)));
          last = values.at(-1);
        }
      return last;
    }
    check(await batch(warmups), warmups - 1, workload);
    let profiling;
    if (process.env.SQLITE_BENCHMARK_PROFILE_DIR !== undefined) {
      const { Session } = await import("node:inspector/promises");
      profiling = new Session();
      profiling.connect();
      if (process.env.SQLITE_BENCHMARK_PROFILE === "cpu") {
        await profiling.post("Profiler.enable");
        await profiling.post("Profiler.start");
      } else
        await profiling.post("HeapProfiler.startSampling", {
          samplingInterval: 4_096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
    }
    const durations = [];
    const cpuStart = process.cpuUsage();
    const heapStart = process.memoryUsage().heapUsed;
    for (let sample = 0; sample < samples; sample++) {
      const started = performance.now();
      const last = await batch(iterations);
      durations.push((performance.now() - started) / iterations);
      check(last, iterations - 1, workload);
    }
    const cpuMicroseconds = process.cpuUsage(cpuStart);
    const heapUsedDeltaBytes = process.memoryUsage().heapUsed - heapStart;
    if (profiling !== undefined) {
      const name = join(process.env.SQLITE_BENCHMARK_PROFILE_DIR, basename(process.cwd()));
      if (process.env.SQLITE_BENCHMARK_PROFILE === "cpu") {
        const cpu = await profiling.post("Profiler.stop");
        await writeFile(`${name}.cpuprofile`, JSON.stringify(cpu.profile));
      } else {
        const heap = await profiling.post("HeapProfiler.stopSampling");
        await writeFile(`${name}.heapprofile`, JSON.stringify(heap.profile));
      }
      profiling.disconnect();
    }
    console.log(
      JSON.stringify({
        phase: "warm",
        candidate,
        workload,
        concurrency,
        warmups,
        samples,
        iterations,
        millisecondsPerOperation: durations,
        cpuMicroseconds,
        heapUsedDeltaBytes,
        databaseVersion:
          driver === "sqlite"
            ? database.prepare("SELECT sqlite_version() AS version").get().version
            : process.env.RUNTIME_BENCHMARK_DATABASE_VERSION,
      }),
    );
  } finally {
    await typed?.close();
    if (driver === "sqlite") database.close();
    else if (database !== undefined) await database.end();
  }
}

async function networkFixture() {
  const grammar = await import(`@typed-sql/${driver}`);
  let pool;
  let query;
  if (driver === "postgres") {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
    query = async (sql, values) => (await pool.query(sql, values)).rows;
  } else {
    const { default: mysql } = await import("mysql2/promise");
    pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 1 });
    query = async (sql, values) => (await pool.query(sql, values))[0];
  }
  try {
    await query("DROP TABLE IF EXISTS runtime_account");
    await query(
      "CREATE TABLE runtime_account (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL, status VARCHAR(16) NOT NULL)",
    );
    const values = [];
    const placeholders = [];
    for (let id = 1; id <= 1_000; id++) {
      values.push(id, `person-${id}@example.com`, "active");
      placeholders.push(
        driver === "postgres" ? `($${values.length - 2},$${values.length - 1},$${values.length})` : "(?,?,?)",
      );
    }
    await query(`INSERT INTO runtime_account VALUES ${placeholders.join(",")}`, values);
    const evidence = (
      await query(driver === "postgres" ? "SHOW server_version" : "SELECT VERSION() AS version, @@sql_mode AS sqlMode")
    )[0];
    const version = driver === "postgres" ? evidence.server_version : evidence.version;
    const server =
      driver === "postgres"
        ? grammar.postgresServerEvidence(version)
        : grammar.mySqlServerEvidence(version, evidence.sqlMode);
    return {
      formatVersion: 1,
      dialect: driver,
      server,
      tables: {
        runtime_account: {
          name: "runtime_account",
          columns: {
            id: {
              name: "id",
              databaseType: driver === "postgres" ? "integer" : "int",
              tsType: "number",
              nullable: false,
            },
            email: { name: "email", databaseType: "varchar(255)", tsType: "string", nullable: false },
            status: { name: "status", databaseType: "varchar(16)", tsType: "string", nullable: false },
          },
        },
      },
    };
  } finally {
    await pool.end();
  }
}

async function fixture(directory, workload, snapshot, candidate) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  if (driver !== "sqlite") {
    await writeFile(join(directory, "query.sql"), workloads[workload].sql);
    await writeFile(
      join(directory, ".reylo.yaml"),
      `direct_url: ${JSON.stringify(databaseUrl())}\nsqlcommenter: false\n`,
    );
    await writeFile(
      join(directory, "typed-sql.config.mjs"),
      `import {${driver}} from '@typed-sql/${driver}'; export default {dialect:${driver}(),schema:{file:'schema.json'},outDir:'.typed-sql'};`,
    );
    await writeFile(join(directory, "schema.json"), JSON.stringify(snapshot));
    return;
  }
  const database = new DatabaseSync(join(directory, "app.db"));
  let server;
  try {
    database.exec(
      "CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL) STRICT; BEGIN",
    );
    const insert = database.prepare("INSERT INTO account VALUES (?, ?, ?)");
    for (let id = 1; id <= 1_000; id++) insert.run(id, `person-${id}@example.com`, "active");
    database.exec("COMMIT");
    const { readNodeSqliteServerEvidence } = await import("@typed-sql/sqlite/node-sqlite");
    server = readNodeSqliteServerEvidence(database);
  } finally {
    database.close();
  }
  await writeFile(join(directory, "query.sql"), workloads[workload].sql);
  await writeFile(join(directory, ".reylo.yaml"), "direct_url: file:./app.db\nsqlcommenter: false\n");
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `import {sqlite} from '@typed-sql/sqlite'; export default {dialect:sqlite({typePolicy:${JSON.stringify(selectedPolicy(candidate))}}),schema:{file:'schema.json'},outDir:'.typed-sql'};`,
  );
  await writeFile(
    join(directory, "schema.json"),
    JSON.stringify({
      formatVersion: 1,
      dialect: "sqlite",
      dialectVersion: "1.0.0",
      server,
      tables: {
        account: {
          name: "account",
          schema: "main",
          kind: "table",
          strict: true,
          withoutRowid: false,
          indexes: [],
          foreignKeys: [],
          columns: {
            id: { name: "id", databaseType: "INTEGER", tsType: "number", nullable: false },
            email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
            status: { name: "status", databaseType: "TEXT", tsType: "string", nullable: false },
          },
        },
      },
    }),
  );
}

async function compileFixture(directory, workload) {
  const { compileSource } = await import("@typed-sql/compiler");
  const grammar = await import(`@typed-sql/${driver}`);
  const dialect = grammar[driver](driver === "sqlite" ? { typePolicy: policy } : {});
  const text = workloads[workload].sql;
  const names = ["first", "last"];
  const escapeTemplateText = (part) => part.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  const parts = [];
  let cursor = 0;
  for (const occurrence of dialect.parameterOccurrences(text)) {
    parts.push(escapeTemplateText(text.slice(cursor, occurrence.range.start)), `\${${names[occurrence.index - 1]}}`);
    cursor = occurrence.range.end;
  }
  parts.push(escapeTemplateText(text.slice(cursor)));
  const parameters = names
    .slice(0, workloads[workload].width === 1 ? 1 : 2)
    .map((name) => `${name}: number`)
    .join(", ");
  const source = `import {sql} from '${dialect.runtimeSqlModule}';\nexport default (${parameters}) => sql\`${parts.join("")}\`;\n`;
  const schema = JSON.parse(await readFile(join(directory, "schema.json"), "utf8"));
  const compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(compiled.queries.length, 1);
  assert.ok(compiled.queries[0].valuePlan, "compiled-inline requires executable compiler metadata");
  await writeFile(join(directory, "compiled.ts"), compiled.transformedSource);
}

async function runWorker(directory, candidate, workload, concurrency, profiles) {
  const args = [];
  if (candidate.startsWith("typed-file")) args.push("--import", "@typed-sql/ts-bridge/sql-register");
  if (candidate.startsWith("reylo")) args.push("--import", "reylo/register");
  args.push(fileURLToPath(import.meta.url), "--worker", candidate, workload, String(concurrency));
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RUNTIME_BENCHMARK_DRIVER: driver,
      ...(profiles === undefined ? {} : { SQLITE_BENCHMARK_PROFILE_DIR: profiles }),
    },
  });
  let output = "";
  let errors = "";
  let startupMilliseconds;
  child.stdout.on("data", (data) => {
    output += String(data);
    if (startupMilliseconds === undefined && output.includes("\n")) startupMilliseconds = performance.now() - started;
  });
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  await new Promise((resolveClose, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${candidate}/${workload}: worker exceeded 120 seconds\n${errors}`));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolveClose() : reject(new Error(`${candidate}/${workload}: ${errors}\n${output}`));
    });
  });
  const records = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return {
    ...records.find((record) => record.phase === "warm"),
    startupMilliseconds,
    firstCallMilliseconds: records.find((record) => record.phase === "first").firstCallMilliseconds,
  };
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3], process.argv[4], Number(process.argv[5]));
} else {
  const startedAt = new Date().toISOString();
  const driverVersions = {};
  if (driver !== "sqlite") {
    const name = driver === "postgres" ? "pg" : "mysql2";
    const adapter = driver === "postgres" ? "@typed-sql/postgres/pg" : "@typed-sql/mysql/mysql2";
    const readVersion = async (lookup) =>
      JSON.parse(await readFile(lookup.resolve(`${name}/package.json`), "utf8")).version;
    driverVersions.rawDriver = await readVersion(createRequire(import.meta.url));
    driverVersions.typedDriver = await readVersion(createRequire(import.meta.resolve(adapter)));
    assert.equal(
      driverVersions.rawDriver,
      driverVersions.typedDriver,
      `Raw/Reylo and typed-sql must use the same ${name} version`,
    );
  }
  const output = resolve(workspace, process.env.SQLITE_BENCHMARK_OUTPUT ?? `results/${driver}-latest.json`);
  await mkdir(dirname(output), { recursive: true });
  const run = await mkdtemp(join(workspace, `results/${driver}-`));
  const snapshot = driver === "sqlite" ? undefined : await networkFixture();
  if (snapshot !== undefined) process.env.RUNTIME_BENCHMARK_DATABASE_VERSION = snapshot.server.version;
  if (
    process.env.SQLITE_BENCHMARK_PROFILE !== undefined &&
    !["cpu", "alloc"].includes(process.env.SQLITE_BENCHMARK_PROFILE)
  )
    throw new TypeError("SQLITE_BENCHMARK_PROFILE must be cpu or alloc");
  const profiles = process.env.SQLITE_BENCHMARK_PROFILE === undefined ? undefined : join(run, "profiles");
  if (profiles !== undefined) await mkdir(profiles);
  const trials = integer("SQLITE_BENCHMARK_TRIALS", 3);
  const results = [];
  let seed = integer("SQLITE_BENCHMARK_SEED", 29);
  const names = selected(
    "SQLITE_BENCHMARK_CANDIDATES",
    driver === "sqlite" ? candidates : candidates.filter((name) => name !== "reylo-sync" && !name.includes("-parsed")),
  );
  const queries = selected("SQLITE_BENCHMARK_WORKLOADS", Object.keys(workloads));
  const concurrency = (process.env.SQLITE_BENCHMARK_CONCURRENCY ?? "1,8").split(",").map((value) => {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("Invalid SQLITE_BENCHMARK_CONCURRENCY");
    return count;
  });
  for (let trial = 0; trial < trials; trial++) {
    const order = [...names];
    for (let index = order.length - 1; index > 0; index--) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const other = Math.floor((seed / 2 ** 32) * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    for (const workload of queries)
      for (const width of concurrency)
        for (const candidate of order) {
          const directory = join(run, `${trial}-${workload}-${width}-${candidate}`);
          const fixtureStarted = performance.now();
          await fixture(directory, workload, snapshot, candidate);
          if (candidate.startsWith("typed-compiled")) await compileFixture(directory, workload);
          const fixtureBuildMilliseconds = performance.now() - fixtureStarted;
          results.push({
            trial,
            fixtureBuildMilliseconds,
            ...(await runWorker(directory, candidate, workload, width, profiles)),
          });
          console.error(`trial ${trial + 1}/${trials}: ${workload} concurrency=${width} ${candidate}`);
        }
  }
  const version = async (name) =>
    JSON.parse(await readFile(join(workspace, "node_modules", name, "package.json"), "utf8")).version;
  const report = {
    context: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(),
      diffHash: createHash("sha256")
        .update(execFileSync("git", ["diff", "HEAD"], { cwd: workspace }))
        .digest("hex"),
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      driver,
      cpu: cpus()[0].model,
      versions: {
        typedSql: await version(`@typed-sql/${driver}`),
        reylo: await version("reylo"),
        reyloGrammar: await version(`@reylosql/${driver}`),
        compiler: await version("@typed-sql/compiler"),
        ...driverVersions,
      },
      trials,
      initialSeed: integer("SQLITE_BENCHMARK_SEED", 29),
      profiles,
      profileMode: process.env.SQLITE_BENCHMARK_PROFILE,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    methodology: `Separate fresh processes/projects avoid competing .sql loaders; deterministic shuffled candidate order per trial. Cold startup is process spawn to first validated query report, including loader imports/analysis but excluding fixture creation; first-call latency separately excludes loader/import/setup. Warm samples exclude imports/setup/warmup/assertions. p50/p95 must be computed from batch-average raw samples, not individual request-tail latency. ${driver === "sqlite" ? "One SQLite connection: concurrency means queued logical calls, not parallel SQLite I/O; raw-cached reuses StatementSync, raw-prepare prepares each call." : driver === "postgres" ? "Pools have maximum10 connections; raw-cached uses a named prepared statement, raw-prepare uses an unnamed parameterized query." : "Pools have maximum10 connections; raw-cached uses mysql2.execute's statement cache, raw-prepare uses mysql2.query's text protocol."} All candidates return equivalent rows; JSON text is parsed within timed operations where the driver/frontend does not decode it; JSON result order is not a workload guarantee. Reylo freshness behavior is unchanged. Heap-used delta is retained-heap noise, not allocated bytes; allocation/CPU attribution comes from separate V8 profiles, whose timings are not comparable to ordinary runs.`,
    results,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(output);
}
