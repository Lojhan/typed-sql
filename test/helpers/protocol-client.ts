import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

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
  readonly reject: (error: Error) => void;
}

export class ProtocolClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #waiters: NotificationWaiter[] = [];
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #stderr = "";

  constructor(
    command: string,
    args: readonly string[],
    workingDirectory: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#process = spawn(command, [...args], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process.stdout.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    this.#process.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString("utf8");
    });
    this.#process.on("error", (error) => this.#fail(error));
    this.#process.on("exit", (code, signal) => {
      if (code === 0) return;
      this.#fail(
        new Error(`Language server exited with ${code ?? signal ?? "unknown status"}. Server stderr:\n${this.#stderr}`),
      );
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
        reject: (error) => {
          clearTimeout(timeout);
          rejectNotification(error);
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

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

export function positionAt(source: string, offset: number): { readonly line: number; readonly character: number } {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return { line: before.split("\n").length - 1, character: offset - lastNewline - 1 };
}
