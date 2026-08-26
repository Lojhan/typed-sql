import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { ProtocolClient, positionAt } from "../../../test/helpers/protocol-client.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../../..");
const fixtureDirectory = join(workspaceDirectory, "test", "fixtures", "success");
const queryFile = join(fixtureDirectory, "query.ts");
const schemaFile = join(fixtureDirectory, "schema.json");
const projectFile = join(fixtureDirectory, "tsconfig.json");
const configFile = join(workspaceDirectory, "e2e", "postgres", "typed-sql.config.ts");
const serverFile = join(workspaceDirectory, "packages/language-server/dist/packages/language-server/src/server.js");

await describe("typed-sql stdio language server", async () => {
  await it("reports a pinned preview crash instead of hanging initialization", async () => {
    const client = new ProtocolClient(process.execPath, [serverFile, "--stdio"], workspaceDirectory, {
      ...process.env,
      TYPED_SQL_TYPESCRIPT_PREVIEW_CLI: join(workspaceDirectory, "missing-typescript-preview.js"),
    });
    try {
      await strict.rejects(
        () =>
          client.request("initialize", {
            processId: process.pid,
            rootUri: pathToFileURL(workspaceDirectory).href,
            capabilities: {},
          }),
        /pinned TypeScript preview process[\s\S]*Reinstall @typed-sql\/language-server@next/u,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  await it("preloads typed overlays for unopened project files", async () => {
    const client = new ProtocolClient(process.execPath, [serverFile, "--stdio"], workspaceDirectory);
    const e2eDirectory = join(workspaceDirectory, "e2e", "postgres");
    const e2eQueryFile = join(e2eDirectory, "src", "query.ts");
    const source = await readFile(e2eQueryFile, "utf8");
    const uri = pathToFileURL(e2eQueryFile).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceDirectory).href,
        workspaceFolders: [{ uri: pathToFileURL(workspaceDirectory).href, name: "typed-sql" }],
        capabilities: {},
        initializationOptions: {
          configPath: join(e2eDirectory, "typed-sql.config.ts"),
          schemaPath: join(e2eDirectory, "generated", "db", "schema.json"),
          projectFile: join(e2eDirectory, "tsconfig.json"),
          nativePreview: true,
        },
      });
      client.notify("initialized", {});
      const hover = (await client.request("textDocument/hover", {
        textDocument: { uri },
        position: positionAt(source, source.indexOf("query")),
      })) as { readonly contents?: unknown };
      const text = JSON.stringify(hover.contents ?? "");
      strict.ok(text.includes("id: bigint"), text);
      strict.ok(!text.includes("unknown"), text);
    } finally {
      await client.close();
    }
  });

  await it("publishes the trusted-fragment quick fix over stdio", async () => {
    const client = new ProtocolClient(process.execPath, [serverFile, "--stdio"], workspaceDirectory);
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      "declare const selected: boolean;",
      "const query = sql`SELECT user.id ${selected ? `, user.name` : sql.empty} FROM users AS user`;",
    ].join("\n");
    const uri = pathToFileURL(join(fixtureDirectory, "structural-fix.ts")).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceDirectory).href,
        workspaceFolders: [{ uri: pathToFileURL(workspaceDirectory).href, name: "typed-sql" }],
        capabilities: {},
        initializationOptions: { configPath: configFile, schemaPath: schemaFile, projectFile, nativePreview: false },
      });
      client.notify("initialized", {});
      const published = client.notification("textDocument/publishDiagnostics", (params) => {
        const value = params as { readonly uri?: string; readonly diagnostics?: readonly { readonly code?: string }[] };
        return value.uri === uri && value.diagnostics?.some(({ code }) => code === "TSQ004") === true;
      });
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: 1, text: source },
      });
      const report = (await published) as {
        readonly diagnostics?: readonly { readonly code?: string; readonly range?: unknown; readonly data?: unknown }[];
      };
      const diagnostic = report.diagnostics?.find(({ code }) => code === "TSQ004");
      strict.ok(diagnostic !== undefined);
      const actions = (await client.request("textDocument/codeAction", {
        textDocument: { uri },
        range: diagnostic?.range,
        context: { diagnostics: [diagnostic] },
      })) as readonly {
        readonly title?: string;
        readonly isPreferred?: boolean;
        readonly edit?: { readonly changes?: Readonly<Record<string, readonly { readonly newText?: string }[]>> };
      }[];
      const action = actions.find(({ title }) => title === "Mark as sql.fragment");
      strict.strictEqual(action?.isPreferred, true);
      strict.strictEqual(action?.edit?.changes?.[uri]?.[0]?.newText, "sql.fragment");
    } finally {
      await client.close();
    }
  });

  await it("makes inferred rows part of the TypeScript 7 semantic program", async () => {
    const client = new ProtocolClient(process.execPath, [serverFile, "--stdio"], workspaceDirectory);
    const source = await readFile(queryFile, "utf8");
    const uri = pathToFileURL(queryFile).href;
    try {
      const initialize = (await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceDirectory).href,
        workspaceFolders: [{ uri: pathToFileURL(workspaceDirectory).href, name: "typed-sql" }],
        capabilities: {},
        initializationOptions: {
          configPath: configFile,
          schemaPath: schemaFile,
          projectFile,
          nativePreview: true,
        },
      })) as {
        readonly capabilities?: { readonly hoverProvider?: boolean };
        readonly serverInfo?: { readonly name?: string };
      };
      strict.strictEqual(initialize.serverInfo?.name, "typed-sql + TypeScript preview");
      strict.strictEqual(initialize.capabilities?.hoverProvider, true);
      client.notify("initialized", {});

      const diagnosticsPromise = client.notification(
        "textDocument/publishDiagnostics",
        (params) => (params as { readonly uri?: string }).uri === uri,
      );
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: 1, text: source },
      });
      const diagnostics = (await diagnosticsPromise) as { readonly diagnostics?: readonly unknown[] };
      strict.deepStrictEqual(diagnostics.diagnostics, []);

      const hoverAt = async (needle: string): Promise<string> => {
        const hover = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position: positionAt(source, source.indexOf(needle)),
        })) as { readonly contents?: unknown };
        return JSON.stringify(hover.contents ?? "");
      };

      const queryHover = await hoverAt("query");
      strict.ok(queryHover.includes("Query<{"), queryHover);
      strict.ok(queryHover.includes("id: number"), queryHover);
      strict.ok(queryHover.includes("age: bigint | null"), queryHover);
      strict.ok(!queryHover.includes("unknown"), queryHover);

      const rowsHover = await hoverAt("rows");
      strict.ok(rowsHover.includes("readonly {"), rowsHover);
      strict.ok(rowsHover.includes("id: number"), rowsHover);
      strict.ok(rowsHover.includes("age: bigint | null"), rowsHover);
      strict.ok(!rowsHover.includes("unknown"), rowsHover);

      const actualHover = await hoverAt("Actual");
      strict.ok(actualHover.includes("id: number"), actualHover);
      strict.ok(actualHover.includes("age: bigint | null"), actualHover);
      strict.ok(!actualHover.includes("unknown"), actualHover);

      const completion = (await client.request("textDocument/completion", {
        textDocument: { uri },
        position: positionAt(source, source.indexOf("user.name") + "user.".length),
      })) as { readonly items?: readonly { readonly label?: string }[] };
      strict.deepStrictEqual(completion.items?.map((item) => item.label).sort(), ["age", "id", "name"]);

      const definition = (await client.request("textDocument/definition", {
        textDocument: { uri },
        position: positionAt(source, source.indexOf("users AS") + 1),
      })) as { readonly uri?: string };
      strict.strictEqual(definition.uri, pathToFileURL(schemaFile).href);

      const changedDiagnosticsPromise = client.notification(
        "textDocument/publishDiagnostics",
        (params) =>
          (params as { readonly uri?: string; readonly version?: number }).uri === uri &&
          (params as { readonly version?: number }).version === 2,
      );
      client.notify("textDocument/didChange", {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: source.replace("user.name", "user.nam") }],
      });
      const changedDiagnostics = (await changedDiagnosticsPromise) as {
        readonly diagnostics?: readonly {
          readonly code?: string;
          readonly source?: string;
          readonly range?: unknown;
          readonly data?: unknown;
        }[];
      };
      const unknown = changedDiagnostics.diagnostics?.find(
        (diagnostic) => diagnostic.source === "typed-sql" && diagnostic.code === "TSQ101",
      );
      strict.ok(unknown !== undefined);
      const actions = (await client.request("textDocument/codeAction", {
        textDocument: { uri },
        range: unknown?.range,
        context: { diagnostics: [unknown] },
      })) as readonly { readonly title?: string; readonly isPreferred?: boolean }[];
      strict.ok(actions.some((action) => action.title === "Replace with name" && action.isPreferred === true));
    } finally {
      await client.close();
    }
  });

  await it("exposes the real PostgreSQL fixture row and Actual types", async () => {
    const client = new ProtocolClient(process.execPath, [serverFile, "--stdio"], workspaceDirectory);
    const e2eDirectory = join(workspaceDirectory, "e2e", "postgres");
    const e2eQueryFile = join(e2eDirectory, "src", "query.ts");
    const source = await readFile(e2eQueryFile, "utf8");
    const uri = pathToFileURL(e2eQueryFile).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceDirectory).href,
        workspaceFolders: [{ uri: pathToFileURL(workspaceDirectory).href, name: "typed-sql" }],
        capabilities: {},
        initializationOptions: {
          configPath: join(e2eDirectory, "typed-sql.config.ts"),
          schemaPath: join(e2eDirectory, "generated", "db", "schema.json"),
          projectFile: join(e2eDirectory, "tsconfig.json"),
          nativePreview: true,
        },
      });
      client.notify("initialized", {});
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: 1, text: source },
      });

      const hoverAt = async (needle: string): Promise<string> => {
        const hover = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position: positionAt(source, source.indexOf(needle)),
        })) as { readonly contents?: unknown };
        return JSON.stringify(hover.contents ?? "");
      };

      const queryHover = await hoverAt("query");
      strict.ok(queryHover.includes("id: bigint"), queryHover);
      strict.ok(!queryHover.includes("unknown"), queryHover);

      const rowsHover = await hoverAt("rows");
      strict.ok(rowsHover.includes("readonly {"), rowsHover);
      strict.ok(rowsHover.includes("id: bigint"), rowsHover);
      strict.ok(rowsHover.includes("email: string"), rowsHover);
      strict.ok(rowsHover.includes('status: \\"active\\" | \\"suspended\\"'), rowsHover);
      strict.ok(rowsHover.includes("budget: string | null"), rowsHover);
      strict.ok(!rowsHover.includes("unknown"), rowsHover);

      const actualHover = await hoverAt("Actual");
      strict.ok(actualHover.includes("id: bigint"), actualHover);
      strict.ok(actualHover.includes("email: string"), actualHover);
      strict.ok(actualHover.includes("budget: string | null"), actualHover);
      strict.ok(!actualHover.includes("unknown"), actualHover);

      const report = (await client.request("textDocument/diagnostic", {
        textDocument: { uri },
      })) as { readonly items?: readonly unknown[] };
      strict.deepStrictEqual(report.items, []);
    } finally {
      await client.close();
    }
  });

  await it("routes each folder in a multi-root workspace through its installed grammar", async () => {
    const client = new ProtocolClient(process.execPath, [serverFile, "--stdio"], workspaceDirectory);
    const postgresRoot = join(workspaceDirectory, "e2e", "postgres");
    const mysqlRoot = join(workspaceDirectory, "e2e", "mysql");
    const postgresSource = `
      import { sql } from "@typed-sql/postgres";
      const postgresQuery = sql\`SELECT account.status FROM users AS account\`;
    `;
    const mysqlSource = `
      import { sql } from "@typed-sql/mysql";
      const mysqlQuery = sql\`SELECT account.active FROM users AS account\`;
    `;
    const postgresUri = pathToFileURL(join(postgresRoot, "src", "editor-multi-root.ts")).href;
    const mysqlUri = pathToFileURL(join(mysqlRoot, "src", "editor-multi-root.ts")).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(postgresRoot).href,
        workspaceFolders: [
          { uri: pathToFileURL(postgresRoot).href, name: "postgres-app" },
          { uri: pathToFileURL(mysqlRoot).href, name: "mysql-app" },
        ],
        capabilities: {},
      });
      client.notify("initialized", {});
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri: postgresUri,
          languageId: "typescript",
          version: 1,
          text: postgresSource,
        },
      });
      client.notify("textDocument/didOpen", {
        textDocument: { uri: mysqlUri, languageId: "typescript", version: 1, text: mysqlSource },
      });

      const postgresHover = await client.request("textDocument/hover", {
        textDocument: { uri: postgresUri },
        position: positionAt(postgresSource, postgresSource.indexOf("postgresQuery")),
      });
      const mysqlHover = await client.request("textDocument/hover", {
        textDocument: { uri: mysqlUri },
        position: positionAt(mysqlSource, mysqlSource.indexOf("mysqlQuery")),
      });
      strict.ok(JSON.stringify(postgresHover).includes('status: \\"active\\" | \\"suspended\\"'));
      strict.ok(JSON.stringify(mysqlHover).includes("active: boolean"));
    } finally {
      await client.close();
    }
  });
});
