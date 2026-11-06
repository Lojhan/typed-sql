import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Deliberately deterministic ACP fixture. It never invokes a model, shell or database, or writes a proposed tool itself.
const sessionId = "isolated-agent-session";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (text) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
let promptId;
let toolServer;
async function callWorkspaceSchema() {
  const headers = Object.fromEntries(toolServer.headers.map(({ name, value }) => [name, value]));
  headers["Content-Type"] = "application/json";
  headers.Accept = "application/json, text/event-stream";
  const call = async (method, params, id) => {
    const result = await fetch(toolServer.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!result.ok) throw new Error("Fixture MCP HTTP failed");
    const message = await result.json();
    if (message.error) throw new Error("Fixture MCP rejected");
    return message.result;
  };
  await call(
    "initialize",
    { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "isolated-browser-fixture", version: "1" } },
    1,
  );
  const result = await call("tools/call", { name: "typed_sql_get_schema", arguments: {} }, 2);
  await appendFile(
    join(process.cwd(), "fake-agent-trace.jsonl"),
    `${JSON.stringify({ action: "tool", name: "typed_sql_get_schema", success: !result.isError })}\n`,
  );
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") response(message.id, { protocolVersion: 1 });
  else if (message.method === "session/new") {
    toolServer = message.params.mcpServers?.[0];
    response(message.id, { sessionId });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params.prompt[0].text.split("\n\nSelected context:\n")[0];
    const latest = [...text.matchAll(/^user: (.+)$/gm)].at(-1)?.[1] ?? "stream";
    await appendFile(
      join(process.cwd(), "fake-agent-trace.jsonl"),
      `${JSON.stringify({ action: "prompt", latest })}\n`,
    );
    if (toolServer) await callWorkspaceSchema();
    update("Partial response from the isolated ACP fixture. ");
    if (latest.startsWith("stream")) {
      const timer = setInterval(async () => {
        try {
          await access(join(process.cwd(), "complete-stream"));
        } catch {
          return;
        }
        clearInterval(timer);
        update(`Completed response. ${"long-message-without-spaces".repeat(180)}`);
        response(promptId, { stopReason: "end_turn" });
      }, 25);
    } else {
      const file = latest.startsWith("accept")
        ? "playground/existing.sql"
        : `playground/${latest.startsWith("cancel") ? "cancelled" : "rejected"}-${"long-segment-".repeat(10)}.sql`;
      send({
        jsonrpc: "2.0",
        id: 100,
        method: "fs/read_text_file",
        params: { sessionId, path: join(process.cwd(), "playground/existing.sql") },
      });
      globalThis.pendingProposal = {
        file,
        source: `select 42 as reviewed_value;\n-- ${"long-proposed-source".repeat(200)}\n`,
      };
    }
  } else if (message.id === 100) {
    await appendFile(
      join(process.cwd(), "fake-agent-trace.jsonl"),
      `${JSON.stringify({ action: "read", success: typeof message.result?.content === "string" })}\n`,
    );
    send({
      jsonrpc: "2.0",
      id: 101,
      method: "fs/write_text_file",
      params: {
        sessionId,
        path: join(process.cwd(), globalThis.pendingProposal.file),
        content: globalThis.pendingProposal.source,
      },
    });
  } else if (message.id === 101) {
    update(
      message.error ? "The proposed change was rejected." : "The reviewed change was accepted; it was not executed.",
    );
    response(promptId, { stopReason: "end_turn" });
  }
}
