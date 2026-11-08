import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer } from "../build/src/consumer.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(directory, "../../artifacts/sqlite-wasm/browser");
await mkdir(artifact, { recursive: true });
let fixture;
let browser;
const servers = [];
const evidence = { driver: "3.54.1-build1", cases: [], errors: [] };
try {
  fixture = await consumer(
    ["vite", "playwright", "@sqlite.org/sqlite-wasm", "typescript", "@types/node"],
    ["@typed-sql/adapters"],
  );
  const root = await fixture.project("browser");
  await Promise.all(["query.sql", "inline.ts"].map((file) => rm(join(root, file))));
  await cp(join(directory, "app"), root, { recursive: true });
  await writeFile(join(root, "policy.mjs"), 'export const integer = "bigint";\n');
  await fixture.node(
    root,
    `import {writeFile} from 'node:fs/promises';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {createSqliteWasmDatabase} from '@typed-sql/adapters/sqlite-wasm';
import { SqliteSchemaProvider } from '@typed-sql/sqlite/analysis';
import {sqliteRenderer} from '@typed-sql/sqlite/query';
const module=await sqlite3InitModule(); const connection=new module.oo1.DB(':memory:');
connection.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT NOT NULL,payload TEXT NOT NULL,bytes BLOB NOT NULL,maybe TEXT) STRICT');
const database=createSqliteWasmDatabase(module,connection,{renderer:sqliteRenderer,profile:{id:'snapshot',dialect:'sqlite',integer:'lossless',jsonWire:'text',typePolicyHash:'snapshot'},ownsConnection:true});
try { const snapshot=await new SqliteSchemaProvider({client:database.queryable}).introspect(); await writeFile('schema.json',JSON.stringify(snapshot)); } finally { await database.close(); }
`,
    "snapshot.mjs",
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        lib: ["ES2024", "DOM", "ESNext.Disposable"],
        allowArbitraryExtensions: true,
      },
      include: ["type-proof.ts"],
    }),
  );
  await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types"]);
  await fixture.command(root, "pnpm", ["exec", "tsc", "--noEmit"]);
  const build = await fixture.node(
    root,
    `import {build} from 'vite'; import {typedSql} from '@typed-sql/build/vite';
await build({root:process.cwd(),configFile:false,plugins:[typedSql({inline:false})],worker:{format:'es',plugins:()=>[typedSql({inline:false})]},build:{minify:false}});`,
    "build.mjs",
  );
  await writeFile(join(artifact, "build.log"), build.output);
  const dist = join(root, "dist");
  const files = await readdir(join(dist, "assets"));
  assert.ok(
    files.some((file) => file.endsWith(".wasm")),
    "Production build must contain the real engine",
  );
  for (const file of files.filter((file) => file.endsWith(".js"))) {
    const text = await readFile(join(dist, "assets", file), "utf8");
    assert.doesNotMatch(text, /(?:from\s*|import\s*\()['"]node:/u);
    assert.doesNotMatch(
      text,
      /Build transforms must not introspect|class SqliteSchemaProvider|typescript\/lib\/typescript/u,
    );
  }
  const require = createRequire(join(fixture.directory, "package.json"));
  const { chromium } = require("playwright");
  if (!process.env.TYPED_SQL_BROWSER_EXECUTABLE) {
    await fixture.command(root, "pnpm", ["exec", "playwright", "install", "chromium"], { timeout: 300000 });
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TYPED_SQL_BROWSER_EXECUTABLE ? { executablePath: process.env.TYPED_SQL_BROWSER_EXECUTABLE } : {}),
  });
  evidence.browser = browser.version();
  for (const backend of ["opfs", "opfs-sahpool"]) {
    const isolated = backend === "opfs";
    const server = createServer(async (request, response) => {
      if (isolated) {
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      }
      const path = new URL(request.url, "http://localhost").pathname;
      if (path !== "/" && !/^\/assets\/[a-zA-Z0-9_.-]+$/u.test(path)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const file = path === "/" ? "index.html" : path.slice(1);
        response.setHeader(
          "Content-Type",
          { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" }[extname(file)] ??
            "application/octet-stream",
        );
        response.end(await readFile(join(dist, file)));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    const network = [];
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    page.on("response", (response) =>
      network.push({ url: response.url().replace(origin, ""), status: response.status() }),
    );
    page.on("pageerror", (error) => evidence.errors.push(String(error)));
    await page.goto(origin);
    await page.waitForFunction(() => !!window.harness);
    const create = () => page.evaluate(() => window.harness.create());
    const call = (worker, method, args = {}) =>
      page.evaluate(({ worker, method, args }) => window.harness.call(worker, method, args), { worker, method, args });
    const terminate = (worker) => page.evaluate((worker) => window.harness.terminate(worker), worker);
    const storage = `typed-sql-${Date.now()}-${backend}`;
    let worker = await create();
    if (!isolated) {
      await assert.rejects(call(worker, "open", { backend: "opfs", directory: storage }), /cross-origin isolation/);
    }
    const runtime = await call(worker, "open", { backend, directory: storage });
    assert.equal(runtime.libraryVersion, "3.54.1");
    assert.equal(runtime.isolated, isolated);
    assert.equal(runtime.sharedArrayBuffer, isolated);
    assert.match(runtime.vfs, isolated ? /^opfs$/u : /sahpool/u);
    assert.ok(runtime.compileOptions.length > 0);
    const results = await call(worker, "exercise");
    await call(worker, "write", { id: 1n, name: "persisted" });
    await call(worker, "close");
    await call(worker, "open", { backend, directory: storage });
    assert.equal((await call(worker, "read", { id: 1n })).name, "persisted");
    await call(worker, "close");
    await terminate(worker);
    worker = await create();
    await call(worker, "open", { backend, directory: storage });
    assert.equal((await call(worker, "read", { id: 1n })).id, 1n);
    if (isolated) {
      const competitor = await create();
      await call(competitor, "open", { backend, directory: storage });
      await call(worker, "hold");
      await assert.rejects(call(competitor, "write", { id: 91n }), /busy|locked|locking|I\/O/i);
      assert.equal(await call(worker, "finish"), 0);
      await call(competitor, "write", { id: 91n, name: "retry succeeded" });
      assert.equal(await call(competitor, "read", { id: 90n }), undefined);
      await call(competitor, "close");
      await terminate(competitor);
    } else {
      const competitor = await create();
      await assert.rejects(call(competitor, "open", { backend, directory: storage }), /access|lock|handle|pool|Error/i);
      assert.equal(
        (await call(worker, "read", { id: 1n })).name,
        "persisted",
        "Conflicting initialization must not delete data",
      );
      await terminate(competitor);
      await call(worker, "close"); // explicitly pauses the application-owned pool
      await terminate(worker);
      worker = await create();
      await call(worker, "open", { backend, directory: storage });
      assert.equal((await call(worker, "read", { id: 1n })).name, "persisted");
    }
    await call(worker, "close");
    await page.reload();
    await page.waitForFunction(() => !!window.harness);
    worker = await create();
    await call(worker, "open", { backend, directory: storage });
    const persisted = await call(worker, "read", { id: 1n });
    assert.equal(persisted.name, "persisted");
    assert.deepEqual(persisted.bytes, Uint8Array.of(0, 255));
    await call(worker, "close");
    await page.evaluate((backend) => {
      document.querySelector("#status").textContent =
        `${backend}: persisted across connection, worker and page restarts; conflict recovery passed`;
    }, backend);
    await page.screenshot({ path: join(artifact, `${backend}.png`) });
    assert.ok(
      network.some((response) => response.url.endsWith(".wasm") && response.status === 200),
      "Browser must fetch the Wasm engine",
    );
    evidence.cases.push({
      backend,
      runtime,
      results,
      persistence: ["connection", "worker", "page"],
      conflictRecovery: true,
      network,
    });
    await context.close();
    console.log(`PASS ${backend}: compiled queries, persistence and conflict recovery`);
  }
  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = String(error);
  throw error;
} finally {
  await writeFile(join(artifact, "results.json"), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await fixture?.close();
}
