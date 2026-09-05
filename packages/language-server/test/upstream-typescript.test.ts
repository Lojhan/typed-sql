import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { ProtocolClient, positionAt } from "../../../test/helpers/protocol-client.js";
import { typescriptPreviewCliPath } from "../../ts-bridge/src/native-lsp.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = join(workspace, "test/fixtures/success");
const server = join(workspace, "packages/language-server/dist/packages/language-server/src/server.js");

interface SemanticTokens {
  resultId?: string;
  data: number[];
}

function tokensAt(data: number[], position: { line: number; character: number }): number[][] {
  let line = 0;
  let character = 0;
  const matches: number[][] = [];
  for (let index = 0; index < data.length; index += 5) {
    line += data[index]!;
    character = data[index] === 0 ? character + data[index + 1]! : data[index + 1]!;
    if (line === position.line && character === position.character) matches.push(data.slice(index + 2, index + 5));
  }
  return matches;
}

await describe("upstream TypeScript LSP integration", async () => {
  await it("retains upstream advertised options through the actual initialization proxy", async () => {
    const upstream = new ProtocolClient(process.execPath, [typescriptPreviewCliPath(), "--lsp", "--stdio"], workspace);
    const proxy = new ProtocolClient(process.execPath, [server, "--stdio"], workspace);
    const params = {
      processId: process.pid,
      rootUri: pathToFileURL(workspace).href,
      capabilities: {
        workspace: { workspaceEdit: { documentChanges: true } },
        textDocument: {
          semanticTokens: {
            requests: { range: true, full: { delta: true } },
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "enum",
              "interface",
              "typeParameter",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "function",
              "method",
            ],
            tokenModifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"],
            formats: ["relative"],
          },
        },
      },
      initializationOptions: {
        configPath: join(workspace, "e2e/postgres/typed-sql.config.ts"),
        schemaPath: join(fixture, "schema.json"),
        projectFile: join(fixture, "tsconfig.json"),
        nativePreview: true,
      },
    };
    try {
      const native = (await upstream.request("initialize", params)) as { capabilities: Record<string, unknown> };
      const extended = (await proxy.request("initialize", params)) as { capabilities: Record<string, unknown> };
      for (const [key, value] of Object.entries(native.capabilities)) {
        if (key === "completionProvider" || key === "codeActionProvider") {
          if (value !== null && typeof value === "object") {
            for (const [option, expected] of Object.entries(value)) {
              const actual = (extended.capabilities[key] as Record<string, unknown>)[option];
              if (Array.isArray(expected)) {
                strict.ok(Array.isArray(actual), `${key}.${option}`);
                for (const item of expected)
                  strict.ok(Array.isArray(actual) && actual.includes(item), `${key}.${option}: ${String(item)}`);
              } else strict.deepStrictEqual(actual, expected, `${key}.${option}`);
            }
          }
        } else strict.deepStrictEqual(extended.capabilities[key], value, key);
      }
      const source = await readFile(join(fixture, "query.ts"), "utf8");
      const uri = pathToFileURL(join(fixture, "query.ts")).href;
      upstream.notify("initialized", {});
      proxy.notify("initialized", {});
      const document = { uri, languageId: "typescript", version: 1, text: source };
      upstream.notify("textDocument/didOpen", { textDocument: document });
      proxy.notify("textDocument/didOpen", { textDocument: document });
      // This symbol follows the injected SQL type overlay. Exact parity therefore
      // checks source mapping as well as preserving ordinary TypeScript behavior.
      const position = positionAt(source, source.indexOf("verify():"));
      for (const method of ["textDocument/definition", "textDocument/references", "textDocument/rename"]) {
        const request = {
          textDocument: { uri },
          position,
          ...(method.endsWith("references") ? { context: { includeDeclaration: true } } : {}),
          ...(method.endsWith("rename") ? { newName: "verifyAccount" } : {}),
        };
        const expected = await upstream.request(method, request);
        strict.ok(expected !== null, `${method} must produce actual upstream evidence`);
        strict.ok(JSON.stringify(expected).includes(uri), `${method} must locate the source document`);
        if (method.endsWith("rename")) strict.ok(JSON.stringify(expected).includes("verifyAccount"));
        strict.deepStrictEqual(await proxy.request(method, request), expected, method);
      }
      const exported = `${source}\nexport const shared = 1;\n`;
      const databaseUri = pathToFileURL(join(fixture, "database.ts")).href;
      const databaseSource = [
        await readFile(join(fixture, "database.ts"), "utf8"),
        'import { sql } from "@typed-sql/postgres";',
        'import { shared } from "./query.js";',
        "const secondQuery = sql`SELECT id FROM users`; void shared; const local={x:1}; void local.x;",
      ].join("\n");
      for (const client of [upstream, proxy]) {
        client.notify("textDocument/didChange", {
          textDocument: { uri, version: 42 },
          contentChanges: [{ text: exported }],
        });
        client.notify("textDocument/didOpen", {
          textDocument: { uri: databaseUri, languageId: "typescript", version: 17, text: databaseSource },
        });
        await client.request("textDocument/hover", {
          textDocument: { uri: databaseUri },
          position: positionAt(databaseSource, databaseSource.lastIndexOf("shared")),
        });
      }
      for (const method of ["textDocument/references", "textDocument/rename"]) {
        const request = {
          textDocument: { uri },
          position: positionAt(exported, exported.lastIndexOf("shared")),
          ...(method.endsWith("references") ? { context: { includeDeclaration: true } } : { newName: "renamedShared" }),
        };
        const expected = await upstream.request(method, request);
        strict.ok(JSON.stringify(expected).includes(databaseUri), `${method} must include the other document`);
        strict.deepStrictEqual(await proxy.request(method, request), expected, `cross-file ${method}`);
      }
      // The pinned upstream returns URI-keyed changes for rename even when the
      // client supports documentChanges. Exercise the version guard explicitly;
      // versioned response round trips are covered by the pure mapper fixtures.
      await strict.rejects(
        proxy.request("textDocument/rename", {
          textDocument: { uri, version: 41 },
          position: positionAt(exported, exported.lastIndexOf("shared")),
          newName: "staleRename",
        }),
        /-32801: Document version does not match/u,
      );
      const completionRequest = {
        textDocument: { uri: databaseUri },
        position: positionAt(databaseSource, databaseSource.lastIndexOf("local.x") + "local.".length),
      };
      const nativeCompletions = (await upstream.request("textDocument/completion", completionRequest)) as {
        items: { label: string }[];
      };
      const proxyCompletions = (await proxy.request("textDocument/completion", completionRequest)) as {
        items: { label: string }[];
      };
      const nativeItem = nativeCompletions.items.find((item) => item.label === "x");
      const proxyItem = proxyCompletions.items.find((item) => item.label === "x");
      strict.ok(nativeItem && proxyItem, "ordinary TypeScript member completion must remain available");
      const nativeResolved = (await upstream.request("completionItem/resolve", nativeItem)) as { detail: string };
      const proxyResolved = (await proxy.request("completionItem/resolve", proxyItem)) as { detail: string };
      strict.ok(nativeResolved.detail.includes("number"));
      strict.strictEqual(proxyResolved.detail, nativeResolved.detail, "upstream completion resolve details");
      const formattingRequest = { textDocument: { uri: databaseUri }, options: { tabSize: 2, insertSpaces: true } };
      const nativeFormatting = (await upstream.request("textDocument/formatting", formattingRequest)) as unknown[];
      strict.ok(nativeFormatting.length > 0, "formatting comparison must produce actual edits");
      strict.deepStrictEqual(await proxy.request("textDocument/formatting", formattingRequest), nativeFormatting);
      const tokenRequest = { textDocument: { uri: databaseUri } };
      const nativeTokens = (await upstream.request("textDocument/semanticTokens/full", tokenRequest)) as SemanticTokens;
      const projected = (await proxy.request("textDocument/semanticTokens/full", tokenRequest)) as SemanticTokens;
      const sharedPosition = positionAt(databaseSource, databaseSource.lastIndexOf("shared"));
      const expectedTokens = tokensAt(nativeTokens.data, sharedPosition);
      strict.ok(expectedTokens.length > 0, "upstream must highlight the symbol after the same-line SQL overlay");
      strict.deepStrictEqual(
        tokensAt(projected.data, sharedPosition),
        expectedTokens,
        "full semantic token source positions",
      );
      const ranged = (await proxy.request("textDocument/semanticTokens/range", {
        ...tokenRequest,
        range: {
          start: { line: sharedPosition.line, character: 0 },
          end: positionAt(databaseSource, databaseSource.length),
        },
      })) as SemanticTokens;
      strict.deepStrictEqual(
        tokensAt(ranged.data, sharedPosition),
        expectedTokens,
        "range semantic token source positions",
      );
      strict.ok(projected.resultId);
      const unchanged = (await proxy.request("textDocument/semanticTokens/full/delta", {
        ...tokenRequest,
        previousResultId: projected.resultId,
      })) as { resultId: string; edits: unknown[] };
      strict.deepStrictEqual(unchanged.edits, []);
      const changedSource = `\n${databaseSource}`;
      proxy.notify("textDocument/didChange", {
        textDocument: { uri: databaseUri, version: 88 },
        contentChanges: [{ text: changedSource }],
      });
      const delta = (await proxy.request("textDocument/semanticTokens/full/delta", {
        ...tokenRequest,
        previousResultId: unchanged.resultId,
      })) as { edits: { start: number; deleteCount: number; data: number[] }[] };
      const reconstructed = [...projected.data];
      for (const edit of delta.edits) reconstructed.splice(edit.start, edit.deleteCount, ...edit.data);
      const changedFull = (await proxy.request("textDocument/semanticTokens/full", tokenRequest)) as SemanticTokens;
      strict.deepStrictEqual(
        reconstructed,
        changedFull.data,
        "source delta reconstructs the full result after an edit",
      );
      strict.deepStrictEqual(
        tokensAt(reconstructed, positionAt(changedSource, changedSource.lastIndexOf("shared"))),
        expectedTokens,
      );
      await strict.rejects(proxy.request("completionItem/resolve", proxyItem), /-32801:/u);
      proxy.notify("textDocument/didClose", { textDocument: { uri: databaseUri } });
      await strict.rejects(proxy.request("completionItem/resolve", proxyItem), /Resolve context expired/u);
    } finally {
      await Promise.all([upstream.close(), proxy.close()]);
    }
  });
});
