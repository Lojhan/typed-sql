import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Verify the application-installed server over stdio; this is not editor-host evidence. */
export async function verifyInitServer(root: string): Promise<void> {
  const require = createRequire(join(root, "package.json"));
  const entry = require.resolve("@typed-sql/language-server");
  const server = join(dirname(entry), "server.js");
  const child = spawn(process.execPath, [server, "--stdio"], { cwd: root, stdio: "pipe" });
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const timeout = setTimeout(() => {
    fail(new Error("Installed language server did not complete its handshake within 30 seconds"));
    child.kill();
  }, 30_000);
  const send = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stderr.resume();
  child.once("exit", () => fail(new Error("Installed language server exited before completing verification")));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Oversized language-server response");
      while (true) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const match = /(?:^|\r\n)Content-Length: (\d+)/iu.exec(buffer.subarray(0, end).toString("ascii"));
        if (match === null) throw new Error("Malformed language-server response");
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024)
          throw new Error("Invalid language-server response length");
        if (buffer.length < end + 4 + length) return;
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8")) as {
          id?: number;
          method?: string;
          error?: { message?: string };
          result?: unknown;
        };
        buffer = buffer.subarray(end + 4 + length);
        if (message.id === undefined) continue;
        if (message.method !== undefined) {
          send({ jsonrpc: "2.0", id: message.id, result: null });
          continue;
        }
        const current = pending.get(message.id);
        pending.delete(message.id);
        if (message.error !== undefined)
          current?.reject(new Error(message.error.message ?? "Language-server request failed"));
        else current?.resolve(message.result);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Invalid server response"));
      child.kill();
    }
  });
  try {
    const initialized = (await request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "application" }],
      capabilities: {},
      initializationOptions: { protocolVersion: 1, protocolCapabilities: ["status"] },
    })) as { serverInfo?: { name?: string } };
    if (initialized?.serverInfo?.name !== "typed-sql + TypeScript preview")
      throw new Error("Unexpected language server implementation");
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const status = (await request("typedSql/status", {})) as { name?: string; typescriptVersion?: string };
    if (status?.name !== "@typed-sql/language-server" || status.typescriptVersion !== "7.1.0-beta")
      throw new Error("The installed language server does not provide the supported TypeScript 7.1.0-beta backend");
    await request("shutdown", null);
    send({ jsonrpc: "2.0", method: "exit", params: null });
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}
