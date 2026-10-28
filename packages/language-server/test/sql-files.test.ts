import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it, strict } from "poku";
import { ProtocolClient, positionAt } from "../../../test/helpers/protocol-client.js";
import { prepareSqlFileConsumer } from "../../../test/helpers/sql-file-consumer.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

await it("honors the official native client's mapper execution permission through the proxy", async () => {
  const root = await mkdtemp(join(workspace, ".sql-proxy-"));
  try {
    const scope = join(root, "node_modules/@typed-sql");
    await mkdir(scope, { recursive: true });
    for (const name of ["core", "postgres", "ts-bridge"]) {
      await symlink(
        join(workspace, "packages", name),
        join(scope, name),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const directory = await prepareSqlFileConsumer(root);
    const file = join(directory, "main.ts");
    const uri = pathToFileURL(file).href;
    const source = 'import find from "./find.sql";\nconst query = find(7, "Ada");\nfind("wrong", "Ada");';
    await writeFile(file, source);
    for (const allowed of [undefined, false, true]) {
      const client = new ProtocolClient(
        process.execPath,
        [join(workspace, "packages/language-server/dist/packages/language-server/src/server.js"), "--stdio"],
        directory,
      );
      try {
        await client.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(directory).href,
          capabilities: { textDocument: { diagnostic: {} } },
          initializationOptions: allowed === undefined ? {} : { runExternalCode: allowed },
        });
        client.notify("initialized", {});
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typescript", version: 1, text: source },
        });
        const result = (await client.request("textDocument/diagnostic", { textDocument: { uri } })) as {
          items: { code?: string | number; message: string }[];
        };
        if (!allowed)
          strict.ok(
            result.items.some((item) => /Cannot find module/u.test(item.message)),
            JSON.stringify(result),
          );
        else {
          strict.ok(
            result.items.some((item) => /not assignable to parameter of type 'number'/u.test(item.message)),
            JSON.stringify(result),
          );
          strict.ok(!result.items.some((item) => /Cannot find module/u.test(item.message)), JSON.stringify(result));
          const hover = await client.request("textDocument/hover", {
            textDocument: { uri },
            position: positionAt(source, source.indexOf("query =") + 1),
          });
          strict.match(JSON.stringify(hover), /id: number/u);
          const sqlFile = join(directory, "find.sql");
          const sqlUri = pathToFileURL(sqlFile).href;
          const invalid = "SELECT '😀' AS emoji,\r\n  missing FROM users";
          client.notify("textDocument/didOpen", {
            textDocument: { uri: sqlUri, languageId: "sql", version: 1, text: await readFile(sqlFile, "utf8") },
          });
          client.notify("textDocument/didChange", {
            textDocument: { uri: sqlUri, version: 2 },
            contentChanges: [{ text: invalid }],
          });
          const sqlDiagnostics = (await client.request("textDocument/diagnostic", {
            textDocument: { uri: sqlUri },
          })) as {
            items: {
              message: string;
              range: { start: { line: number; character: number }; end: { line: number; character: number } };
            }[];
          };
          const missing = sqlDiagnostics.items.find((item) => /TSQ101/u.test(item.message));
          strict.deepStrictEqual(
            missing?.range,
            { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
            JSON.stringify(sqlDiagnostics),
          );
        }
      } finally {
        await client.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
