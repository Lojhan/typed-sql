import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { ProtocolClient } from "../../test/helpers/protocol-client.ts";

/** Only setup uses workspace code; CLI, build, editor and execution use installed tarballs. */
export async function qualifyPackedContracts(fixture) {
  const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
  assert.ok(password && !/[;{}]/u.test(password));
  const name = `typed_sql_packed_contract_${randomBytes(6).toString("hex")}`;
  const dsn = (database) =>
    `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
  const admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
  const project = join(fixture.directory, "native-contracts");
  const cli = join(fixture.directory, "node_modules/@typed-sql/cli/dist/packages/cli/src/cli.js");
  const build = join(fixture.directory, "node_modules/@typed-sql/build/dist/packages/build/src/cli.js");
  const server = join(
    fixture.directory,
    "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js",
  );
  const from = " FROM dbo.contract_records a LEFT JOIN dbo.contract_records b ON a.id=b.id WHERE a.id=1";
  const initial = `SELECT IS_SRVROLEMEMBER(N'sysadmin') AS value${from}`;
  const changed = `SELECT CAST(IS_SRVROLEMEMBER(N'sysadmin') AS bigint) AS value${from}`;
  const source = (sql) =>
    `import {sql} from "@typed-sql/sqlserver";\nexport const query=sql\`${sql}\`;\n` +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source checked through installed packages.
    "export function bound(value:bigint){return sql`SELECT CAST(${value} AS bigint) AS value`;}\n";
  const environment = (mode) => ({
    ...process.env,
    TYPED_SQL_CONTRACT_MODE: mode,
    TYPED_SQL_CONTRACT_DSN: mode === "live" ? dsn(name) : "",
  });
  let phase = "initial generation";
  const command = async (args, mode = "live") => {
    try {
      return await fixture.command(project, process.execPath, [cli, ...args], { env: environment(mode) });
    } catch (error) {
      throw new Error(`SQL Server contract fixture (${phase}): ${String(error)}`);
    }
  };
  let created = false;
  try {
    await admin.queryable.all(`CREATE DATABASE [${name}]`);
    created = true;
    await admin.queryable.all(`ALTER DATABASE [${name}] SET QUERY_STORE=OFF`);
    const db = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    await db.queryable.all("CREATE TABLE dbo.contract_records (id bigint NOT NULL PRIMARY KEY)");
    await db.queryable.all("INSERT dbo.contract_records VALUES (1)");
    const schema = {
      formatVersion: 1,
      dialect: "sqlserver",
      tables: {
        contract_records: {
          schema: "dbo",
          name: "contract_records",
          columns: {
            id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
          },
        },
      },
      server: db.serverEvidence,
    };
    await db.close();
    await mkdir(project);
    await writeFile(join(project, "schema.json"), JSON.stringify(schema));
    await writeFile(
      join(project, "tsconfig.json"),
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
    await writeFile(join(project, "application.ts"), source(initial));
    await writeFile(join(project, "shape.sql"), initial);
    await writeFile(
      join(project, "sql-import.ts"),
      'import query from "./shape.sql"; import {bound} from "./application.js"; export {query,bound};\n',
    );
    await writeFile(
      join(project, "typed-sql.config.mjs"),
      `
import {sqlserverProfile} from "@typed-sql/sqlserver/profile";
import {sqlServerContractIdentity,sqlServerContractAdapterVersion,sqlServerContractReconciliationOwner} from "@typed-sql/sqlserver/contract-profile";
const mode=process.env.TYPED_SQL_CONTRACT_MODE??"live";
const connectionContext="0".repeat(64);
export default {
 dialect:{...sqlserverProfile(),async loadAnalyzer(){
  if(mode!=="live")throw Error("Recorded SQL Server checking initialized an analyzer");
  return (await import("@typed-sql/sqlserver/analysis/core")).sqlserver();
 }},schema:{file:"schema.json"},outDir:"generated",projects:["tsconfig.json"],
 analysis:{mode,identity:sqlServerContractIdentity(),contractsDir:"contracts",
 cache:{connectionContext,adapter:{id:"@typed-sql/sqlserver/native-contracts",version:sqlServerContractAdapterVersion}},
 qualification:{mode:"native-required",owner:sqlServerContractReconciliationOwner,requiredNativeFacets:["runtime-type"]},
 live:{contextIntervalMs:1,async adapter({schema,typePolicy}){
  if(mode!=="live")throw Error("Recorded SQL Server checking initialized a native adapter");
  const {createSqlServerOdbcNativeContractAdapter}=await import("@typed-sql/sqlserver/odbc-contracts");
  const {createSqlServerContractReconciler}=await import("@typed-sql/sqlserver/reconciliation");
  const adapter=createSqlServerOdbcNativeContractAdapter({schema,typePolicy,connectionString:process.env.TYPED_SQL_CONTRACT_DSN});
  return {connectionContext,adapter,contribution:createSqlServerContractReconciler({typePolicy}),inspectContext:signal=>adapter.inspectContext(signal),async close(){}};
 }}}
};`,
    );
    await command(["generate", "--queries", "--live"]);
    const declarations = async () => {
      await fixture.command(project, process.execPath, [build, "types"], { env: environment("frozen") });
      await fixture.command(project, "pnpm", ["exec", "tsc", "--noEmit"], { env: environment("frozen") });
      return readFile(join(project, "shape.d.sql.ts"), "utf8");
    };
    assert.match(await declarations(), /"value": number/u);
    const original = await readFile(join(project, "contracts/manifest.json"), "utf8");
    await writeFile(join(project, "application.ts"), source(changed));
    await writeFile(join(project, "shape.sql"), changed);
    phase = "changed-query generation";
    await command(["generate", "--queries", "--live"]);
    assert.match(await declarations(), /"value": bigint/u);
    assert.notEqual(await readFile(join(project, "contracts/manifest.json"), "utf8"), original);
    await writeFile(
      join(project, "bundle.mjs"),
      `
import assert from "node:assert/strict";
import {build} from "esbuild";
import {typedSql} from "@typed-sql/build/esbuild";
await build({entryPoints:["sql-import.ts"],outfile:"query.mjs",bundle:true,format:"esm",platform:"node",external:["@typed-sql/*"],plugins:[typedSql()]});`,
    );
    await fixture.command(project, process.execPath, ["bundle.mjs"], { env: environment("frozen") });
    await writeFile(
      join(project, "execute.mjs"),
      `
import assert from "node:assert/strict";
import {getQueryValuePlan} from "@typed-sql/core";
import {createSqlServerOdbcDatabase} from "@typed-sql/sqlserver/odbc";
import {query,bound} from "./query.mjs";
const statement=query();assert.equal(getQueryValuePlan(statement).columns[0].type,"bigint");
const db=await createSqlServerOdbcDatabase({connectionString:process.env.TYPED_SQL_CONTRACT_DSN});
try{assert.deepEqual(await db.one(statement),{value:1n});assert.deepEqual(await db.one(bound(42n)),{value:42n});}finally{await db.close();}`,
    );
    await fixture.command(project, process.execPath, ["execute.mjs"], { env: environment("live") });
    for (const languageId of ["typescript", "sql"]) {
      const uri = pathToFileURL(join(project, languageId === "sql" ? "shape.sql" : "application.ts")).href;
      const text = (sql) => (languageId === "sql" ? sql : source(sql));
      const open = async (mode, sql) => {
        const client = new ProtocolClient(process.execPath, [server, "--stdio"], project, environment(mode));
        try {
          await client.request("initialize", {
            processId: null,
            rootUri: pathToFileURL(project).href,
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
      const inspect = async (client, sql, expected) => {
        let diagnostics;
        for (let attempt = 0; ; attempt++) {
          try {
            diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
            break;
          } catch (error) {
            if (attempt >= 2 || !String(error).includes("-32802")) throw error;
          }
        }
        assert.ok(
          !diagnostics.items.some((item) => item.severity === 1),
          JSON.stringify({ phase, languageId, diagnostics }),
        );
        const prefix = text(sql).slice(0, text(sql).indexOf("SELECT")).split("\n");
        const hover = await client.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: prefix.length - 1, character: prefix.at(-1).length },
        });
        assert.match(JSON.stringify(hover), new RegExp(`value[^}]*${expected}`, "u"));
      };
      phase = `${languageId} initial live editor`;
      const live = await open("live", initial);
      try {
        await inspect(live, initial, "number");
        if (languageId === "typescript") {
          const before = await live.request("typedSql/status", {});
          await admin.queryable.all(
            `EXEC [${name}].sys.sp_executesql N'CREATE FUNCTION dbo.contract_context_marker() RETURNS int AS BEGIN RETURN 1 END'`,
          );
          phase = `${languageId} routine-change editor refresh`;
          await inspect(live, initial, "number");
          const after = await live.request("typedSql/status", {});
          assert.ok(after.workspaces[0].metrics.generation > before.workspaces[0].metrics.generation);
          await admin.queryable.all(
            `EXEC [${name}].sys.sp_executesql N'ALTER TABLE dbo.contract_records ADD context_marker int NULL'`,
          );
          phase = `${languageId} table-change editor refresh`;
          await inspect(live, initial, "number");
          const tableAfter = await live.request("typedSql/status", {});
          assert.ok(tableAfter.workspaces[0].metrics.generation > after.workspaces[0].metrics.generation);
        }
        live.notify("textDocument/didChange", {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: text("SELECT 2 AS value") }],
        });
        live.notify("textDocument/didChange", {
          textDocument: { uri, version: 3 },
          contentChanges: [{ text: text(changed) }],
        });
        phase = `${languageId} changed-query live editor`;
        await inspect(live, changed, "bigint");
      } finally {
        await live.close();
      }
      await rename(join(project, "contracts"), join(project, "contracts-held"));
      try {
        phase = `${languageId} cache-only offline editor`;
        const offline = await open("offline", initial);
        try {
          await inspect(offline, initial, "number");
        } finally {
          await offline.close();
        }
      } finally {
        await rename(join(project, "contracts-held"), join(project, "contracts"));
      }
    }
    // Fresh durable contracts must bind the latest observed context after the editor's DDL fixture.
    phase = "post-editor context generation";
    await command(["generate", "--queries", "--live"]);
    await rm(join(project, ".typed-sql"), { recursive: true, force: true });
    await admin.queryable.all(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
    await admin.queryable.all(`DROP DATABASE [${name}]`);
    created = false;
    assert.match((await command(["check", "--frozen", "--show-types"], "frozen")).output, /bigint/u);
    assert.match(await declarations(), /"value": bigint/u);
    await fixture.command(project, process.execPath, ["bundle.mjs"], { env: environment("frozen") });
    console.log(
      "Installed SQL Server query-contract generation, decoding, live editors and disconnected frozen builds passed",
    );
  } finally {
    try {
      if (created) {
        await admin.queryable.all(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
        await admin.queryable.all(`DROP DATABASE [${name}]`);
      }
    } finally {
      await admin.close();
    }
  }
}
