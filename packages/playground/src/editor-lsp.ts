import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { WorkspaceError } from "./files.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Grammar-neutral, bounded LSP stdio transport. It never installs or imports a language server. */
export class EditorLspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;
  constructor(
    command: string,
    args: readonly string[],
    cwd: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.child = spawn(command, [...args], {
      cwd,
      stdio: "pipe",
      shell: false,
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", () => {
      /* Drain native diagnostics; never expose project paths or secrets. */
    });
    this.child.on("error", () => this.fail("Language server could not start"));
    this.child.on("exit", () => this.fail("Language server stopped"));
    this.child.stdin.on("error", () => this.fail("Language server input closed"));
  }
  private send(value: unknown): void {
    if (this.closed) throw new WorkspaceError("EDITOR_SERVER", "Language server is unavailable", 503);
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > 2 * 1024 * 1024) throw new WorkspaceError("EDITOR_LIMIT", "Language server message is too large");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 64)
      return Promise.reject(new WorkspaceError("EDITOR_BUSY", "Language server is busy", 429));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.notify("$/cancelRequest", { id });
        } catch {
          /* Already closed. */
        }
        reject(new WorkspaceError("EDITOR_TIMEOUT", "Language server request timed out", 504));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private receive(chunk: Buffer) {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > 4 * 1024 * 1024)
      return this.fail("Language server output exceeded its limit");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length > 0) {
        const boundary = this.buffer.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (this.buffer.length > 8192) this.fail("Invalid language server framing");
          return;
        }
        if (boundary > 8192) return this.fail("Invalid language server framing");
        const header = this.buffer.subarray(0, boundary).toString("ascii");
        const lengths = [...header.matchAll(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?=\r\n|$)/giu)];
        if (lengths.length !== 1) return this.fail("Invalid language server framing");
        const size = Number(lengths[0]?.[1]);
        if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024)
          return this.fail("Language server message exceeded its limit");
        if (this.buffer.length < boundary + 4 + size) return;
        const value = JSON.parse(this.buffer.subarray(boundary + 4, boundary + 4 + size).toString("utf8"));
        this.buffer = this.buffer.subarray(boundary + 4 + size);
        if (value === null || typeof value !== "object" || value.jsonrpc !== "2.0")
          return this.fail("Invalid language server message");
        if (typeof value.method === "string") {
          if (value.id !== undefined) {
            // No server-initiated filesystem edits, commands, or unrestricted configuration reads.
            const result =
              value.method === "workspace/configuration" && Array.isArray(value.params?.items)
                ? value.params.items.map(() => null)
                : null;
            this.send(
              value.method === "workspace/applyEdit"
                ? {
                    jsonrpc: "2.0",
                    id: value.id,
                    result: { applied: false, failureReason: "Review edits in the editor" },
                  }
                : { jsonrpc: "2.0", id: value.id, result },
            );
          }
          continue;
        }
        const pending = this.pending.get(value.id);
        if (pending === undefined) continue;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        if (value.error !== undefined)
          pending.reject(new WorkspaceError("EDITOR_REQUEST", "Language server could not complete this request", 422));
        else pending.resolve(value.result);
      }
    } catch {
      this.fail("Invalid language server response");
    }
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WorkspaceError("EDITOR_SERVER", message, 503));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    try {
      if (this.child.pid !== undefined && process.platform !== "win32") process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  async close(): Promise<void> {
    const exited = this.child.exitCode !== null || this.child.signalCode !== null;
    const closed = exited
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          this.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
    this.fail("Language server closed");
    await closed;
  }
}
