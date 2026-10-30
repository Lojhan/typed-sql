import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBuildProject } from "../../../test/helpers/build-project.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tools = JSON.parse(await readFile(join(repository, "e2e/build/hosts.json"), "utf8"));

export async function command(cwd, executable, args, options = {}) {
  return new Promise((fulfill, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env, PATH: `${options.bin ?? ""}${options.bin ? ":" : ""}${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk) => {
      output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") child.kill("SIGKILL");
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }, options.timeout ?? 180_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, output };
      if (code !== 0 && !options.allowFailure)
        reject(new Error(`${executable} ${args.join(" ")} failed (${code ?? signal})\n${output}`));
      else fulfill(result);
    });
  });
}

/** Reserve only an ephemeral loopback port, and terminate only the child process group we own. */
export async function server(cwd, args, environment = {}) {
  const port = await new Promise((fulfill, reject) => {
    const reservation = createServer();
    reservation.on("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const value = reservation.address().port;
      reservation.close((error) => (error ? reject(error) : fulfill(value)));
    });
  });
  const child = spawn(
    process.execPath,
    args.map((arg) => arg.replaceAll("{port}", String(port))),
    {
      cwd,
      detached: true,
      env: { ...process.env, ...environment, PORT: String(port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const exited = new Promise((fulfill) => child.once("close", fulfill));
    process.kill(-child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }, 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    output: () => output,
    close,
    async fetch(path) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Server stopped: ${spawnError ?? output}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
          return response;
        } catch {}
        await new Promise((fulfill) => setTimeout(fulfill, 100));
      }
      throw new Error(`Server did not respond\n${output}`);
    },
  };
}

/** All library imports resolve to packed artifacts, never workspace source links. */
export async function consumer(hosts, libraries = []) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-build-e2e-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  try {
    const packages = new Map();
    for (const entry of await readdir(join(repository, "packages"))) {
      try {
        const location = join(repository, "packages", entry);
        const metadata = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
        packages.set(metadata.name, { location, metadata });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const dependencies = {};
    const pack = async (name) => {
      if (dependencies[name] !== undefined) return;
      const { location, metadata } = packages.get(name);
      const filename = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${metadata.version}.tgz`;
      dependencies[name] = `file:${join(artifacts, filename)}`;
      for (const dependency of Object.keys(metadata.dependencies ?? {}))
        if (packages.has(dependency)) await pack(dependency);
      await command(location, "pnpm", ["pack", "--out", join(artifacts, filename)]);
    };
    await pack("@typed-sql/build");
    await pack("@typed-sql/sqlite");
    for (const library of libraries) await pack(library);
    const devDependencies = Object.fromEntries(
      hosts.map((name) => {
        if (tools[name] === undefined) throw new Error(`Unpinned host ${name}`);
        return [name, tools[name]];
      }),
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "packed-build-consumer",
        type: "module",
        private: true,
        dependencies,
        devDependencies,
        pnpm: { overrides: dependencies },
      }),
    );
    await command(directory, "pnpm", ["install", "--ignore-workspace", "--ignore-scripts"], { timeout: 300_000 });
    return {
      directory,
      command(project, executable, args, options = {}) {
        return command(project, executable, args, { ...options, bin: join(directory, "node_modules/.bin") });
      },
      async project(name) {
        const root = join(directory, name);
        await prepareBuildProject(root);
        return root;
      },
      async node(project, source, name = "host.mjs") {
        await writeFile(join(project, name), source);
        return command(project, process.execPath, [name]);
      },
      async close() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const execution = `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getQueryValuePlan } from "@typed-sql/core";
import { createSqliteDatabase } from "@typed-sql/sqlite/runtime";
import { typePolicy } from "@typed-sql/sqlite";
export async function verify({ query, inline, repeated, conditional }) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE account(id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT; INSERT INTO account VALUES (1,'a@example.com'),(2,'b@example.com');");
  const db = createSqliteDatabase({ typePolicy: { ...typePolicy, integer: "number" }, connection: {
    all(text, values = []) { return raw.prepare(text).all(...values); },
    exec(text) { raw.exec(text); },
    iterate(text, values = []) { return raw.prepare(text).iterate(...values); },
  } });
  try {
    for (const value of [query(1), ...(inline ? [inline(1), repeated([1,2]), conditional(true)] : [])]) assert.ok(getQueryValuePlan(value), "compiled plan must survive host transformation");
    const expected = [{id:1,email:"a@example.com"}];
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(await db.all(query(1))), expected);
    if (inline) {
    assert.deepEqual(plain(await db.all(inline(1))), expected);
    assert.deepEqual(plain(await db.all(repeated([1,2]))), [...expected,{id:2,email:"b@example.com"}]);
    assert.deepEqual(plain(await db.all(conditional(false))), [{id:1}]);
    assert.deepEqual(plain(await db.all(conditional(true))), expected);
    await assert.rejects(() => db.all(inline("wrong")));
    }
  } finally { raw.close(); }
}
`;

export async function writeEntry(root) {
  await writeFile(join(root, "verify.mjs"), execution);
  await writeFile(
    join(root, "entry.ts"),
    `import query from "./query.sql";\nimport { inline, repeated, conditional } from "./inline.ts";\nexport type HostEntry = { readonly checked: true };\nexport { query, inline, repeated, conditional };\n`,
  );
}
