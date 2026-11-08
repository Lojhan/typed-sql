import { execFile as callback } from "node:child_process";
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createConnection } from "mysql2/promise";
import { strict } from "poku";
import { mysql2 } from "../../packages/mysql/src/mysql2.js";
import { createPackedNativeEditorConsumer } from "./packed-editor-consumer.js";
import { ProtocolClient } from "./protocol-client.js";

const execFile = promisify(callback);

/** Qualify installed CLI/LSP entrypoints, not workspace source imports. */
export async function assertMySqlPackedContracts(workspace: string, connectionUri: string): Promise<void> {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  const fixture = await createPackedNativeEditorConsumer(workspace, environment, ["mysql"], ["@typed-sql/build"]);
  const directory = fixture.consumer;
  const cli = join(directory, "node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js");
  const build = join(directory, "node_modules/@typed-sql/build/dist/packages/build/src/cli.js");
  const server = join(directory, "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js");
  const marker = `typed_sql_packed_context_${process.pid}`;
  const table = `${marker}_items`;
  const initial = `SELECT TO_SECONDS(created_at) AS value FROM ${table}`;
  const changed = `SELECT REVERSE(label) AS value FROM ${table} WHERE id=1`;
  let admin: Awaited<ReturnType<typeof createConnection>> | undefined;
  const command = async (args: readonly string[], mode = "live") =>
    execFile(process.execPath, [cli, ...args], {
      cwd: directory,
      env: { ...environment, TYPED_SQL_MYSQL_CONTRACT_MODE: mode, TYPED_SQL_MYSQL_CONTRACT_URI: connectionUri },
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
    admin = await createConnection(connectionUri);
    await admin.query(
      `CREATE TABLE ${table}(id INT PRIMARY KEY,created_at DATE NOT NULL,label VARCHAR(32) NOT NULL) ENGINE=InnoDB`,
    );
    await admin.query(`INSERT INTO ${table} VALUES (1,'2024-01-01','value')`);
    const schema = await mysql2({ connectionUri }).introspect();
    // The packed fixture first proves that no driver is installed transitively.
    await symlink(join(workspace, "node_modules/mysql2"), join(directory, "node_modules/mysql2"), "dir");
    await symlink(
      join(workspace, "packages/build/node_modules/esbuild"),
      join(directory, "node_modules/esbuild"),
      "dir",
    );
    await writeFile(join(directory, "schema.json"), JSON.stringify(schema));
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          allowArbitraryExtensions: true,
        },
        files: ["application.ts", "sql-import.ts"],
      }),
    );
    const source = (sql: string) => `import {sql} from "@typed-sql/mysql";\nexport const query=sql\`${sql}\`;\n`;
    await writeFile(join(directory, "application.ts"), source(initial));
    await writeFile(join(directory, "shape.sql"), initial);
    await writeFile(join(directory, "sql-import.ts"), 'import query from "./shape.sql"; export {query};\n');
    await writeFile(
      join(directory, "typed-sql.config.mjs"),
      `import {defineConfig} from "@typed-sql/core";
import {mysqlProfile} from "@typed-sql/mysql/profile";
import {mySqlContractIdentity,mySqlContractAdapterVersion,mySqlContractReconciliationOwner} from "@typed-sql/mysql/contract-profile";
const mode=process.env.TYPED_SQL_MYSQL_CONTRACT_MODE??"live";
export default defineConfig({
 dialect:{...mysqlProfile(),async loadAnalyzer(){
  if(mode!=="live")throw Error("Recorded checking initialized an analyzer");
  return (await import("@typed-sql/mysql/analysis")).mysql();
 }},schema:{file:"schema.json"},outDir:"generated",projects:["tsconfig.json"],
 analysis:{mode,identity:mySqlContractIdentity(),contractsDir:"contracts",
  cache:{connectionContext:"0".repeat(64),adapter:{id:"@typed-sql/mysql/mysql2-contracts",version:mySqlContractAdapterVersion}},
  qualification:{mode:"hybrid",owner:mySqlContractReconciliationOwner,requiredNativeFacets:["runtime-type"]},
  live:{contextIntervalMs:1,async adapter({schema}){
   if(mode!=="live")throw Error("Recorded checking initialized a native adapter");
   const {createMySql2NativeContractAdapter}=await import("@typed-sql/mysql/mysql2-contracts");
   const {createMySqlContractReconciler}=await import("@typed-sql/mysql/reconciliation");
   const adapter=createMySql2NativeContractAdapter({schema,connectionUri:process.env.TYPED_SQL_MYSQL_CONTRACT_URI});
   return {connectionContext:"0".repeat(64),adapter,contribution:createMySqlContractReconciler(),inspectContext:signal=>adapter.inspectContext(signal),async close(){}};
  }}
 }
});`,
    );
    await command(["generate", "--queries", "--live"]);
    const frozenEnv = {
      ...environment,
      TYPED_SQL_MYSQL_CONTRACT_MODE: "frozen",
      TYPED_SQL_MYSQL_CONTRACT_URI: connectionUri,
    };
    const declarations = async () => {
      await execFile(process.execPath, [build, "types"], { cwd: directory, env: frozenEnv });
      await execFile("pnpm", ["exec", "tsc", "--noEmit"], { cwd: directory, env: frozenEnv });
      return readFile(join(directory, "shape.d.sql.ts"), "utf8");
    };
    strict.match(await declarations(), /bigint/u);
    strict.match((await command(["check", "--show-types"], "frozen")).stdout, /bigint/u);
    const original = await readFile(join(directory, "contracts/manifest.json"), "utf8");
    await writeFile(join(directory, "application.ts"), source(changed));
    await writeFile(join(directory, "shape.sql"), changed);
    await command(["generate", "--queries", "--live"]);
    strict.match(await declarations(), /string/u);
    strict.match((await command(["check", "--show-types"], "frozen")).stdout, /string/u);
    strict.notEqual(await readFile(join(directory, "contracts/manifest.json"), "utf8"), original);
    await writeFile(
      join(directory, "bundle.mjs"),
      `
import assert from "node:assert/strict";
import {build} from "esbuild";
import {typedSql} from "@typed-sql/build/esbuild";
import {getQueryValuePlan} from "@typed-sql/core";
import {createMySql2Database} from "@typed-sql/mysql/mysql2";
await build({entryPoints:["sql-import.ts"],outfile:"query.mjs",bundle:true,format:"esm",platform:"node",external:["@typed-sql/*"],plugins:[typedSql()]});
const {query}=await import("./query.mjs");
const statement=query();
assert.equal(getQueryValuePlan(statement).columns[0].type,"string");
const database=await createMySql2Database({connectionUri:process.env.TYPED_SQL_MYSQL_CONTRACT_URI});
try{assert.deepEqual(await database.execute(statement),[{value:"eulav"}]);}finally{await database.close();}
`,
    );
    await execFile(process.execPath, ["bundle.mjs"], { cwd: directory, env: frozenEnv });

    for (const languageId of ["typescript", "sql"]) {
      const uri = pathToFileURL(join(directory, languageId === "sql" ? "shape.sql" : "application.ts")).href;
      const text = (sql: string) => (languageId === "sql" ? sql : source(sql));
      const open = async (mode: "live" | "offline", sql: string) => {
        const client = new ProtocolClient(process.execPath, [server, "--stdio"], directory, {
          ...environment,
          TYPED_SQL_MYSQL_CONTRACT_MODE: mode,
          ...(mode === "live" ? { TYPED_SQL_MYSQL_CONTRACT_URI: connectionUri } : {}),
        });
        try {
          await client.request("initialize", {
            processId: null,
            rootUri: pathToFileURL(directory).href,
            capabilities: { textDocument: { diagnostic: {} } },
            initializationOptions: { nativePreview: false },
          });
          client.notify("initialized", {});
          client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text: text(sql) } });
          return client;
        } catch (error) {
          await client.close();
          throw error;
        }
      };
      const inspect = async (client: ProtocolClient, sql: string, expected: string) => {
        let diagnostics: { items: { severity?: number; message: string }[] };
        for (let attempt = 0; ; attempt++) {
          try {
            diagnostics = (await client.request("textDocument/diagnostic", {
              textDocument: { uri },
            })) as typeof diagnostics;
            break;
          } catch (error) {
            if (attempt >= 2 || !String(error).includes("-32802")) throw error;
          }
        }
        strict.ok(!diagnostics.items.some((item) => item.severity === 1), JSON.stringify(diagnostics));
        const prefix = text(sql).slice(0, text(sql).indexOf("SELECT")).split("\n");
        const hover = await client.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: prefix.length - 1, character: prefix.at(-1)!.length },
        });
        strict.match(JSON.stringify(hover), new RegExp(`value[^}]*${expected}`, "u"));
      };
      const live = await open("live", initial);
      try {
        await inspect(live, initial, "bigint");
        if (languageId === "typescript") {
          const before = (await live.request("typedSql/status", {})) as {
            workspaces: { metrics: { generation: number } }[];
          };
          await admin.query(`CREATE FUNCTION ${marker}() RETURNS INT DETERMINISTIC RETURN 1`);
          await inspect(live, initial, "bigint");
          const after = (await live.request("typedSql/status", {})) as typeof before;
          strict.ok(after.workspaces[0]!.metrics.generation > before.workspaces[0]!.metrics.generation);
          await admin.query(`ALTER TABLE ${table} ADD COLUMN context_marker INT`);
          await inspect(live, initial, "bigint");
          const tableAfter = (await live.request("typedSql/status", {})) as typeof before;
          strict.ok(
            tableAfter.workspaces[0]!.metrics.generation > after.workspaces[0]!.metrics.generation,
            "Installed editor must regenerate after table DDL with an unchanged supplied schema",
          );
        }
        live.notify("textDocument/didChange", {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: text("SELECT 2 AS value") }],
        });
        live.notify("textDocument/didChange", {
          textDocument: { uri, version: 3 },
          contentChanges: [{ text: text(changed) }],
        });
        await inspect(live, changed, "string");
      } finally {
        await live.close();
      }
      await rename(join(directory, "contracts"), join(directory, "contracts-held"));
      try {
        const offline = await open("offline", initial);
        try {
          await inspect(offline, initial, "bigint");
        } finally {
          await offline.close();
        }
      } finally {
        await rename(join(directory, "contracts-held"), join(directory, "contracts"));
      }
    }
  } finally {
    try {
      await admin?.query(`DROP FUNCTION IF EXISTS ${marker}`);
    } finally {
      try {
        await admin?.query(`DROP TABLE IF EXISTS ${table}`);
      } finally {
        try {
          await admin?.end();
        } finally {
          await fixture.close();
        }
      }
    }
  }
}
