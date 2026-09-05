const { appendFileSync } = require("node:fs");
const record = (event, options) =>
  appendFileSync(process.env.TYPED_SQL_HOST_MARKER, `${JSON.stringify({ event, pid: process.pid, options })}\n`);
record("start");
process.on("exit", () => record("exit"));
process.on("SIGTERM", () => process.exit(0));
let buffer = Buffer.alloc(0);
function reply(id, result) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary).toString())[1]);
    if (buffer.length < boundary + 4 + length) return;
    const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length));
    buffer = buffer.subarray(boundary + 4 + length);
    if (message.method === "exit") process.exit(0);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      setTimeout(() => {
        record("ready", message.params.initializationOptions);
        reply(message.id, { capabilities: { hoverProvider: true, textDocumentSync: 1 } });
      }, 1000);
    } else if (message.method === "textDocument/hover")
      reply(message.id, { contents: { kind: "markdown", value: `probe-${process.pid}` } });
    else reply(message.id, null);
  }
});
