import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = { integer: "number", flexible: "union", unknown: "unknown" };
const candidates = [
  "raw-cached",
  "raw-prepare",
  "typed-inline",
  "typed-prepared",
  "typed-file",
  "typed-file-prepared",
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
  const rows = workload === "point" ? [value] : workload === "json" ? value.items : value;
  assert.equal(rows.length, width);
  for (const [offset, row] of rows.entries()) {
    assert.equal(row.id, first + offset);
    assert.equal(row.email, `person-${first + offset}@example.com`);
    assert.equal(row.status, "active");
  }
}

async function worker(candidate, workload, concurrency) {
  const database = new DatabaseSync("app.db");
  const { sql: text, width } = workloads[workload];
  let typed;
  let run;
  if (candidate.startsWith("raw")) {
    const statement = candidate === "raw-cached" ? database.prepare(text) : undefined;
    run = (values) => (statement ?? database.prepare(text)).all(...values);
  } else if (candidate.startsWith("reylo")) {
    const { default: query } = await import(pathToFileURL(resolve("query.sql")).href);
    run = (values) =>
      query[candidate === "reylo-sync" ? "runSync" : "run"](
        database,
        values.length === 1 ? { 1: values[0] } : { 1: values[0], 2: values[1] },
      );
  } else {
    const { sql } = await import("@typed-sql/sqlite");
    const { adaptNodeSqliteDatabase } = await import("@typed-sql/sqlite/node-sqlite");
    const { createSqliteDatabase } = await import("@typed-sql/sqlite/runtime");
    typed = createSqliteDatabase({
      connection: adaptNodeSqliteDatabase(database, { typePolicy: policy }),
      ownsConnection: false,
    });
    let factory;
    if (candidate.startsWith("typed-file")) factory = (await import(pathToFileURL(resolve("query.sql")).href)).default;
    else if (workload === "point") factory = (id) => sql`SELECT id, email, status FROM account WHERE id = ${id}`;
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
        sqliteVersion: database.prepare("SELECT sqlite_version() AS version").get().version,
      }),
    );
  } finally {
    await typed?.close();
    database.close();
  }
}

async function fixture(directory, workload) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
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
    `import {sqlite} from '@typed-sql/sqlite'; export default {dialect:sqlite({typePolicy:${JSON.stringify(policy)}}),schema:{file:'schema.json'},outDir:'.typed-sql'};`,
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

async function runWorker(directory, candidate, workload, concurrency, profiles) {
  const args = [];
  if (candidate.startsWith("typed-file")) args.push("--import", "@typed-sql/ts-bridge/sql-register");
  if (candidate.startsWith("reylo")) args.push("--import", "reylo/register");
  args.push(fileURLToPath(import.meta.url), "--worker", candidate, workload, String(concurrency));
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(profiles === undefined ? {} : { SQLITE_BENCHMARK_PROFILE_DIR: profiles }) },
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
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveClose() : reject(new Error(`${candidate}/${workload}: ${errors}\n${output}`)),
    );
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
  const output = resolve(workspace, process.env.SQLITE_BENCHMARK_OUTPUT ?? "results/sqlite-latest.json");
  await mkdir(dirname(output), { recursive: true });
  const run = await mkdtemp(join(workspace, "results/sqlite-"));
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
  const names = selected("SQLITE_BENCHMARK_CANDIDATES", candidates);
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
          await fixture(directory, workload);
          results.push({ trial, ...(await runWorker(directory, candidate, workload, width, profiles)) });
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
      cpu: cpus()[0].model,
      versions: {
        typedSql: await version("@typed-sql/sqlite"),
        reylo: await version("reylo"),
        reyloSqlite: await version("@reylosql/sqlite"),
      },
      trials,
      initialSeed: integer("SQLITE_BENCHMARK_SEED", 29),
      profiles,
      profileMode: process.env.SQLITE_BENCHMARK_PROFILE,
    },
    methodology:
      "Separate fresh processes/projects avoid competing .sql loaders; deterministic shuffled candidate order per trial. Cold startup is process spawn to first validated query report, including loader imports/analysis but excluding fixture creation; first-call latency separately excludes loader/import/setup. Warm samples exclude imports/setup/warmup/assertions. p50/p95 must be computed from batch-average raw samples, not individual request-tail latency. One SQLite connection, so concurrency means queued logical calls, not parallel SQLite I/O. All candidates return equivalent rows; JSON text is parsed within timed operations where the driver/frontend does not decode it. Reylo freshness behavior is unchanged. Heap-used delta is retained-heap noise, not allocated bytes; allocation/CPU attribution comes from separate V8 profiles, whose timings are not comparable to ordinary runs.",
    results,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(output);
}
