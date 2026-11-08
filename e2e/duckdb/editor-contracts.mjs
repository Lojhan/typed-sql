import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProtocolClient } from "../../test/helpers/protocol-client.js";

/** Exercise the packaged language server and SDK, including an unsaved native-only result. */
export async function verifyEditorContracts(fixture, directory, artifacts, engine, database) {
  const server = join(
    fixture.directory,
    "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js",
  );
  const transcript = [];
  const ddl = (sql) =>
    fixture.node(
      directory,
      `
import * as sdk from "@duckdb/node-api";
const instance=await sdk.DuckDBInstance.create(${JSON.stringify(database)});
const connection=await instance.connect();
try{const result=await connection.run(${JSON.stringify(sql)});result.closeSync();}
finally{connection.closeSync();instance.closeSync();}
`,
      "editor-ddl.mjs",
    );
  for (const languageId of ["typescript", "sql"]) {
    const uri = pathToFileURL(join(directory, languageId === "sql" ? "shape.sql" : "live.ts")).href;
    const source = (type) => {
      const sql = `SELECT json_transform('{}', '{"x":"${type}"}') AS value FROM records WHERE id=9223372036854775807::BIGINT`;
      return languageId === "sql" ? sql : `import {sql} from "@typed-sql/duckdb";\nexport const query=sql\`${sql}\`;\n`;
    };
    const pull = async (client) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await client.request("textDocument/diagnostic", { textDocument: { uri } });
        } catch (error) {
          if (attempt >= 2 || !String(error).includes("-32802")) throw error;
        }
      }
    };
    const inspect = async (client, text, expected) => {
      const diagnostics = await pull(client);
      assert.equal(
        diagnostics.items.some((item) => item.severity === 1),
        false,
        JSON.stringify(diagnostics),
      );
      const prefix = text.slice(0, text.indexOf("SELECT")).split("\n");
      const hover = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: prefix.length - 1, character: prefix.at(-1).length },
      });
      assert.ok(hover.contents.value.includes(`"x": ${expected} | null`), JSON.stringify(hover));
      transcript.push(JSON.stringify({ languageId, diagnostics, hover }));
    };
    const open = async (offline, text, version) => {
      const client = new ProtocolClient(process.execPath, [server, "--stdio"], directory, {
        ...process.env,
        TYPED_SQL_DUCKDB_CONTRACT_FROZEN: "0",
        TYPED_SQL_DUCKDB_CONTRACT_OFFLINE: offline ? "1" : "0",
      });
      try {
        await client.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(directory).href,
          capabilities: { textDocument: { diagnostic: {} } },
          initializationOptions: { nativePreview: false },
        });
        client.notify("initialized", {});
        client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    };
    const initial = source("BOOLEAN");
    const live = await open(false, initial, 1);
    try {
      await inspect(live, initial, "boolean");
      const status = await live.request("typedSql/status", {});
      assert.equal(status.workspaces[0].metrics.analysis.observation, "request-driven");
      assert.equal(typeof status.workspaces[0].metrics.analysis.lastContextCheckAt, "number");
      if (languageId === "typescript") {
        await ddl("CREATE TYPE typed_sql_editor_context_marker AS STRUCT(note VARCHAR)");
        await inspect(live, initial, "boolean");
        const changed = await live.request("typedSql/status", {});
        assert.ok(
          changed.workspaces[0].metrics.generation > status.workspaces[0].metrics.generation,
          "A live request must observe catalog drift even when the document text is unchanged",
        );
        await ddl("ALTER TABLE records ADD COLUMN typed_sql_editor_context_column VARCHAR");
        await inspect(live, initial, "boolean");
        const tableChanged = await live.request("typedSql/status", {});
        assert.ok(
          tableChanged.workspaces[0].metrics.generation > changed.workspaces[0].metrics.generation,
          "A live request must observe table DDL with an unchanged supplied schema",
        );
      }
      // Two unsaved replacements must not allow the older result to replace the current view.
      live.notify("textDocument/didChange", {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: source("INTEGER") }],
      });
      live.notify("textDocument/didChange", {
        textDocument: { uri, version: 3 },
        contentChanges: [{ text: source("VARCHAR") }],
      });
      await inspect(live, source("VARCHAR"), "string");
    } finally {
      await live.close();
    }
    await rename(join(directory, "contracts"), join(directory, "contracts-held"));
    try {
      const offline = await open(true, initial, 1);
      try {
        await inspect(offline, initial, "boolean");
      } finally {
        await offline.close();
      }
    } finally {
      await rename(join(directory, "contracts-held"), join(directory, "contracts"));
    }
    if (languageId === "typescript") {
      await ddl("DROP TYPE typed_sql_editor_context_marker");
      await ddl("ALTER TABLE records DROP COLUMN typed_sql_editor_context_column");
    }
  }
  await writeFile(join(artifacts, `${engine}-editor-contracts.log`), `${transcript.join("\n")}\n`);
}
