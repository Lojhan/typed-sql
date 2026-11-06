import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it, strict } from "poku";
import { ProtocolClient, positionAt } from "../../../test/helpers/protocol-client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
await it("keeps JavaScript SQL overlays checked and maps diagnostics to original interpolation positions", async () => {
  const directory = await mkdtemp(join(root, ".javascript-lsp-"));
  const file = join(directory, "query.js");
  const uri = pathToFileURL(file).href;
  const client = new ProtocolClient(
    process.execPath,
    [join(root, "packages/language-server/dist/packages/language-server/src/server.js")],
    directory,
  );
  try {
    const projectFile = join(directory, "tsconfig.json");
    await writeFile(
      projectFile,
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          strict: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
        },
        include: ["query.js"],
      }),
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const source =
      'import { sql } from "@typed-sql/postgres";\nconst query = sql`SELECT id FROM users`;\nconst result = query;\nresult;';
    await writeFile(file, source);
    await client.request("initialize", {
      processId: null,
      rootUri: pathToFileURL(directory).href,
      capabilities: { textDocument: { diagnostic: {} } },
      initializationOptions: {
        configPath: join(root, "e2e/postgres/typed-sql.config.ts"),
        projectFile,
        schemaPath: join(root, "test/fixtures/success/schema.json"),
      },
    });
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "javascript", version: 1, text: source },
    });
    const hover = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: 2 },
    });
    strict.match(JSON.stringify(hover), /id: number/u);
    strict.doesNotMatch(JSON.stringify(hover), /unknown/u);
    const wrong =
      'import { sql } from "@typed-sql/postgres";\nconst query = sql`SELECT id FROM users WHERE id = ${"wrong"}`;\nquery;';
    client.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: wrong }] });
    const diagnostics = (await client.request("textDocument/diagnostic", { textDocument: { uri } })) as {
      items: {
        code: number | string;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
      }[];
    };
    const mismatch = diagnostics.items.find((item) => item.code === 2345);
    strict.ok(mismatch, JSON.stringify(diagnostics));
    strict.equal(mismatch.range.start.line, 1);
    strict.ok(
      mismatch.range.start.character >= positionAt(wrong, wrong.indexOf('"wrong"')).character,
      JSON.stringify(mismatch),
    );
    strict.ok(!diagnostics.items.some((item) => item.code === 1005), JSON.stringify(diagnostics));
    const invalid = source.replace("SELECT id FROM users", "SELECT absent FROM users");
    client.notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: invalid }] });
    const failure = (await client.request("textDocument/diagnostic", { textDocument: { uri } })) as {
      items: { code: number | string }[];
    };
    strict.ok(
      failure.items.some((item) => item.code === "TSQ101"),
      JSON.stringify(failure),
    );
    const unknown = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: 2 },
    });
    strict.match(JSON.stringify(unknown), /unknown/u);
    strict.doesNotMatch(JSON.stringify(unknown), /id: number/u);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
