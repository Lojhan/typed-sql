const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TYPED_SQL_HOST_MARKER, "started");
let buffer = Buffer.alloc(0);
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
    const result = message.method === "initialize" ? { capabilities: {} } : null;
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
});
