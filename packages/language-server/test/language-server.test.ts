import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";

interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface NotificationWaiter {
  readonly method: string;
  readonly predicate: (params: unknown) => boolean;
  readonly resolve: (params: unknown) => void;
}

class ProtocolClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #waiters: NotificationWaiter[] = [];
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #stderr = "";

  constructor(serverFile: string, workingDirectory: string) {
    this.#process = spawn(process.execPath, [serverFile, "--stdio"], {
      cwd: workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process.stdout.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    this.#process.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString("utf8");
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  notification(method: string, predicate: (params: unknown) => boolean): Promise<unknown> {
    return new Promise((resolveNotification, rejectNotification) => {
      const timeout = setTimeout(() => {
        rejectNotification(new Error(`Timed out waiting for ${method}. Server stderr:\n${this.#stderr}`));
      }, 20_000);
      this.#waiters.push({
        method,
        predicate,
        resolve: (params) => {
          clearTimeout(timeout);
          resolveNotification(params);
        },
      });
    });
  }

  async close(): Promise<void> {
    if (this.#process.exitCode !== null) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
      await new Promise<void>((resolveClose) => {
        const timeout = setTimeout(() => {
          this.#process.kill();
          resolveClose();
        }, 5_000);
        this.#process.once("close", () => {
          clearTimeout(timeout);
          resolveClose();
        });
      });
    } finally {
      if (this.#process.exitCode === null) this.#process.kill();
    }
  }

  #send(message: JsonRpcMessage): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.#process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#process.stdin.write(body);
  }

  #drain(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header);
      if (lengthMatch?.[1] === undefined) throw new Error(`Missing Content-Length in ${header}`);
      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      const messageEnd = bodyStart + contentLength;
      if (this.#buffer.length < messageEnd) return;
      const message = JSON.parse(this.#buffer.subarray(bodyStart, messageEnd).toString("utf8")) as JsonRpcMessage;
      this.#buffer = this.#buffer.subarray(messageEnd);
      this.#receive(message);
    }
  }

  #receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method !== undefined) {
      const result =
        message.method === "workspace/configuration" &&
        typeof message.params === "object" &&
        message.params !== null &&
        Array.isArray((message.params as { readonly items?: unknown }).items)
          ? (message.params as { readonly items: readonly unknown[] }).items.map(() => null)
          : null;
      this.#send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error === undefined) pending.resolve(message.result);
      else pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      return;
    }
    if (message.method === undefined) return;
    const waiterIndex = this.#waiters.findIndex(
      (waiter) => waiter.method === message.method && waiter.predicate(message.params),
    );
    if (waiterIndex === -1) return;
    const [waiter] = this.#waiters.splice(waiterIndex, 1);
    waiter?.resolve(message.params);
  }
}

function positionAt(source: string, offset: number): { readonly line: number; readonly character: number } {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return { line: before.split("\n").length - 1, character: offset - lastNewline - 1 };
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../../..");
const fixtureDirectory = join(workspaceDirectory, "test", "fixtures", "success");
const queryFile = join(fixtureDirectory, "query.ts");
const schemaFile = join(fixtureDirectory, "schema.json");
const projectFile = join(fixtureDirectory, "tsconfig.json");
const configFile = join(workspaceDirectory, "e2e", "postgres", "typed-sql.config.ts");
const serverFile = join(workspaceDirectory, "packages/language-server/dist/packages/language-server/src/server.js");

await describe("typed-sql stdio language server", async () => {
  await it("preloads typed overlays for unopened project files", async () => {
    const client = new ProtocolClient(serverFile, workspaceDirectory);
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

  await it("makes inferred rows part of the TypeScript 7 semantic program", async () => {
    const client = new ProtocolClient(serverFile, workspaceDirectory);
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
    const client = new ProtocolClient(serverFile, workspaceDirectory);
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
});
