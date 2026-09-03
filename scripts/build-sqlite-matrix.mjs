import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new TypeError(`Invalid argument ${name ?? "<missing>"}`);
  options[name.slice(2)] = value;
}

for (const name of ["url", "sha3", "output", "version"]) {
  if (typeof options[name] !== "string" || options[name].length === 0) throw new TypeError(`--${name} is required`);
}
if (!/^[a-f\d]{64}$/u.test(options.sha3)) throw new TypeError("--sha3 must be a SHA3-256 digest");

function run(command, args) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) fulfill(stdout);
      else reject(new Error(`${basename(command)} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

async function findSource(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const nested = await findSource(path, filename);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

const temporary = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-matrix-"));
try {
  const response = await fetch(options.url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SQLite source download failed with HTTP ${response.status}`);
  const archive = join(temporary, basename(new URL(options.url).pathname) || "sqlite-source.tar.gz");
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha3-256").update(archiveBytes).digest("hex");
  if (digest !== options.sha3)
    throw new Error(`SQLite source digest mismatch: expected ${options.sha3}, received ${digest}`);
  await writeFile(archive, archiveBytes);

  const sourceDirectory = join(temporary, "source");
  await mkdir(sourceDirectory);
  await run("tar", ["-xzf", archive, "-C", sourceDirectory]);
  const sqliteSource = await findSource(sourceDirectory, "sqlite3.c");
  const shellSource = await findSource(sourceDirectory, "shell.c");
  if (sqliteSource === undefined || shellSource === undefined) {
    throw new Error("SQLite source archive does not contain sqlite3.c and shell.c");
  }

  const output = resolve(options.output);
  await mkdir(resolve(output, ".."), { recursive: true });
  await run(process.env.CC ?? "cc", [
    "-O0",
    "-DSQLITE_ENABLE_MATH_FUNCTIONS",
    "-DSQLITE_ENABLE_PERCENTILE",
    shellSource,
    sqliteSource,
    "-ldl",
    "-lpthread",
    "-lm",
    "-o",
    output,
  ]);
  const actualVersion = (await run(output, ["--version"])).trim().split(/\s+/u)[0];
  if (actualVersion !== options.version) {
    throw new Error(`Built SQLite ${actualVersion || "<missing>"}; expected ${options.version}`);
  }
  process.stdout.write(`${output}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
