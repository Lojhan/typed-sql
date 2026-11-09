import { execFile as callback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { strict } from "poku";
import { ProtocolClient } from "./protocol-client.js";

/** Installed worker/CLI/editor proof; no workspace imports or third-party SQLite drivers. */
export async function assertSqliteNativeContractConsumer(consumer: string, env: NodeJS.ProcessEnv) {
  const { DatabaseSync } = await import("node:sqlite");
  const probe = new DatabaseSync(":memory:");
  const statement = probe.prepare("SELECT 1");
  const supported = typeof probe.setAuthorizer === "function" && typeof statement.columns === "function";
  if ("close" in statement && typeof statement.close === "function") statement.close();
  probe.close();
  // The pinned qualification job runs this proof; unit tests cover hosts missing these APIs.
  if (!supported) return;
  const run = promisify(callback);
  const directory = join(consumer, "sqlite-native-contracts");
  await mkdir(directory);
  const cli = join(consumer, "node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js");
  const command = (args: string[]) =>
    run(process.execPath, [cli, ...args], { cwd: directory, env, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(directory, "schema.json"), JSON.stringify({ formatVersion: 1, dialect: "sqlite", tables: {} }));
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      files: ["application.ts"],
    }),
  );
  const original =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal application source consumed by the installed compiler.
    'import {sql} from "@typed-sql/sqlite"; export function query(value:bigint|string){return sql`SELECT ${value} AS value`;}';
  await writeFile(join(directory, "application.ts"), original);
  await writeFile(
    join(directory, "setup.mjs"),
    `import {DatabaseSync} from "node:sqlite";
const db=new DatabaseSync("database.sqlite");db.exec("CREATE TABLE marker(value INTEGER) STRICT");db.close();`,
  );
  await run(process.execPath, ["setup.mjs"], { cwd: directory, env });
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `
import {fileURLToPath} from "node:url";
import {sqliteProfile} from "@typed-sql/sqlite/profile";
import {sqliteContractIdentity,sqliteContractReconciliationOwner} from "@typed-sql/sqlite/contract-profile";
import {queryContractDigest} from "@typed-sql/analysis";
const connectionContext=queryContractDigest("packed-sqlite-native-target");
export default {dialect:{...sqliteProfile(),async loadAnalyzer(){return (await import("@typed-sql/sqlite/analysis/core")).sqlite();}},
schema:{file:"schema.json"},outDir:"generated",projects:["tsconfig.json"],analysis:{mode:"live",
identity:sqliteContractIdentity(),qualification:{mode:"native-required",owner:sqliteContractReconciliationOwner,requiredNativeFacets:["runtime-type"]},
cache:{connectionContext,adapter:{id:"@typed-sql/sqlite/node-sqlite-contracts",version:"node-sqlite-readonly-prepare-v1"}},
live:{async adapter({schema,typePolicy}){
const {createNodeSqliteNativeContractAdapter}=await import("@typed-sql/sqlite/node-sqlite-contracts");
const {createSqliteContractReconciler}=await import("@typed-sql/sqlite/reconciliation");
const adapter=createNodeSqliteNativeContractAdapter({path:fileURLToPath(new URL("./database.sqlite",import.meta.url)),schema,typePolicy});
return {connectionContext,adapter,contribution:createSqliteContractReconciler({typePolicy}),inspectContext:signal=>adapter.inspectContext(signal),close:async()=>{}};
}}}};`,
  );
  await command(["generate", "--queries", "--live"]);
  strict.match((await command(["check", "--frozen", "--show-types"])).stdout, /bigint/u);
  const source = original.replace("SELECT ", "SELECT CAST(").replace(" AS value", " AS TEXT) AS value");
  await writeFile(join(directory, "application.ts"), source);
  await command(["generate", "--queries", "--live"]);
  await writeFile(
    join(directory, "execute.mjs"),
    `
import assert from "node:assert/strict";
import {loadQueryContracts} from "@typed-sql/analysis";
import {sql,withQueryValuePlan} from "@typed-sql/core";
import {createNodeSqliteDatabase} from "@typed-sql/sqlite/node-sqlite";
const contracts=await loadQueryContracts("generated/contracts");
const db=await createNodeSqliteDatabase({path:"database.sqlite"});
try{assert.deepEqual(await db.one(withQueryValuePlan(sql\`SELECT CAST(\${"hello"} AS TEXT) AS value\`,contracts[0].valuePlan)),{value:"hello"});}finally{await db.close();}`,
  );
  await run(process.execPath, ["execute.mjs"], { cwd: directory, env });
  const editor = new ProtocolClient(
    process.execPath,
    [join(consumer, "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js"), "--stdio"],
    directory,
    env,
  );
  try {
    const uri = pathToFileURL(join(directory, "application.ts")).href;
    const text = original.replace("SELECT ", "VALUES (").replace(" AS value", ")");
    await editor.request("initialize", {
      processId: null,
      rootUri: pathToFileURL(directory).href,
      capabilities: { textDocument: { diagnostic: {} } },
      initializationOptions: { nativePreview: false },
    });
    editor.notify("initialized", {});
    editor.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
    const diagnostics = (await editor.request("textDocument/diagnostic", { textDocument: { uri } })) as {
      items: { severity?: number }[];
    };
    strict.ok(!diagnostics.items.some(({ severity }) => severity === 1), JSON.stringify(diagnostics));
    const prefix = text.slice(0, text.indexOf("VALUES")).split("\n");
    strict.match(
      JSON.stringify(
        await editor.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: prefix.length - 1, character: prefix.at(-1)!.length },
        }),
      ),
      /bigint/u,
    );
  } finally {
    await editor.close();
  }
  // Frozen consumption must not open the native worker, inspect a file, or read the private cache.
  await rm(join(directory, "database.sqlite"));
  await rm(join(directory, ".typed-sql"), { recursive: true, force: true });
  const configFile = join(directory, "typed-sql.config.mjs");
  const config = await readFile(configFile, "utf8");
  await writeFile(
    configFile,
    config
      .replace('mode:"live"', 'mode:"frozen"')
      .replace(
        'async loadAnalyzer(){return (await import("@typed-sql/sqlite/analysis/core")).sqlite();}',
        'loadAnalyzer(){throw Error("Frozen SQLite analyzer must remain cold");}',
      )
      .replace(
        "async adapter({schema,typePolicy}){",
        'async adapter({schema,typePolicy}){throw Error("Frozen SQLite native factory must remain cold");',
      ),
  );
  strict.match((await command(["check", "--frozen", "--show-types"])).stdout, /bigint/u);
}
