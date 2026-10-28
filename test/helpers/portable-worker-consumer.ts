import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { strict } from "poku";
import type { D1Binding } from "../../packages/adapters/src/d1.js";

/** Exercise an installed frontend/runtime package closure with an actual Worker build. */
export async function assertPortableWorkerConsumer(options: {
  consumer: string;
  viteUrl: string;
  miniflareUrl: string;
}): Promise<void> {
  const directory = join(options.consumer, "portable-worker-consumer");
  await mkdir(directory);
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `import { sqlite, typePolicy } from "@typed-sql/sqlite";
export default { dialect: sqlite({ typePolicy: { ...typePolicy, integer: "number" } }), schema: { file: "schema.json" }, outDir: ".typed-sql" };`,
  );
  const table = {
    schema: "main",
    name: "items",
    kind: "table",
    strict: true,
    withoutRowid: false,
    indexes: [],
    foreignKeys: [],
    columns: {
      id: { name: "id", databaseType: "INTEGER", tsType: "number", nullable: false },
      name: { name: "name", databaseType: "TEXT", tsType: "string", nullable: false },
    },
  };
  await writeFile(
    join(directory, "schema.json"),
    JSON.stringify({
      formatVersion: 1,
      dialect: "sqlite",
      dialectVersion: "1.0.0",
      tables: { items: table, unused_build_schema_marker: { ...table, name: "unused_build_schema_marker" } },
    }),
  );
  await writeFile(join(directory, "find.sql"), "SELECT id, name FROM items WHERE id = ?");
  const worker = join(directory, "worker.ts");
  await writeFile(
    worker,
    `import find, { valuePlan } from "./find.sql";
import { sql, sqliteRenderer } from "@typed-sql/sqlite/query";
import { createD1Database } from "@typed-sql/adapters/d1";
export default { async fetch(_request: Request, env: { DB: import("@typed-sql/adapters/d1").D1Binding }) {
  const database = createD1Database(env.DB, { renderer: sqliteRenderer, profile: { id: "worker-d1", dialect: "sqlite", integer: "safe-number", jsonWire: "text", typePolicyHash: valuePlan.typePolicyHash } });
  const inline = sql\`SELECT name FROM items WHERE id = \${1}\`;
  const conditional = (includeName: boolean) => sql\`SELECT id\${includeName ? sql.fragment\`, name\` : sql.empty} FROM items WHERE id = \${1}\`;
  const many = (ids: readonly number[]) => sql\`SELECT id, name FROM items WHERE id IN (\${ids.map(id => sql.fragment\`\${id}\`)}) ORDER BY id\`;
  return Response.json({ files: await database.all(find(1)), inline: await database.all(inline), conditional: [await database.all(conditional(true)), await database.all(conditional(false))], repeated: [await database.all(many([1])), await database.all(many([1, 2, 3]))] });
} };`,
  );
  const require = createRequire(join(directory, "package.json"));
  const { typedSql } = (await import(pathToFileURL(require.resolve("@typed-sql/ts-bridge/vite")).href)) as {
    typedSql: typeof import("../../packages/ts-bridge/src/vite.js").typedSql;
  };
  const { build } = (await import(options.viteUrl)) as {
    build(options: unknown): Promise<unknown>;
  };
  const buildOptions = {
    root: directory,
    configFile: false,
    logLevel: "silent",
    plugins: [typedSql()],
    ssr: { target: "webworker", noExternal: true },
    build: { ssr: worker, minify: false, outDir: "dist", rollupOptions: { output: { entryFileNames: "worker.js" } } },
  };
  await build(buildOptions);
  const code = await readFile(join(directory, "dist/worker.js"), "utf8");
  strict.ok(!code.includes("node:"), "Worker artifact must not import Node builtins");
  strict.ok(!code.includes("unused_build_schema_marker"), "Worker artifact must not contain the schema snapshot");
  strict.ok(!code.includes("loadSqlFileProject"), "Worker artifact must not contain the compiler/config loader");
  const { Miniflare } = (await import(options.miniflareUrl)) as {
    Miniflare: new (
      options: unknown,
    ) => {
      getD1Database(name: string): Promise<D1Binding>;
      dispatchFetch(url: string): Promise<Response>;
      dispose(): Promise<void>;
    };
  };
  const mf = new Miniflare({ modules: true, script: code, compatibilityDate: "2026-07-30", d1Databases: ["DB"] });
  try {
    const binding = await mf.getD1Database("DB");
    await binding.prepare("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT").all();
    await binding.prepare("INSERT INTO items VALUES (?, ?)").bind(1, "Ada").all();
    await binding.prepare("INSERT INTO items VALUES (?, ?)").bind(2, "Grace").all();
    const response = await mf.dispatchFetch("https://worker.test/");
    strict.equal(response.status, 200);
    strict.deepEqual(await response.json(), {
      files: [{ id: 1, name: "Ada" }],
      inline: [{ name: "Ada" }],
      conditional: [[{ id: 1, name: "Ada" }], [{ id: 1 }]],
      repeated: [
        [{ id: 1, name: "Ada" }],
        [
          { id: 1, name: "Ada" },
          { id: 2, name: "Grace" },
        ],
      ],
    });
  } finally {
    await mf.dispose();
  }
  await writeFile(join(directory, "find.sql"), "SELECT missing FROM items");
  await strict.rejects(build(buildOptions), /TSQ101/u);
  const plugin = typedSql({ config: "missing-config-file" });
  strict.equal(
    await plugin.transform.call({ addWatchFile() {} }, "export const unrelated = 1;", join(directory, "unrelated.ts")),
    null,
  );
}
