import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { type AgentConversation, AgentRoutes } from "../src/agents.js";
import { WorkspaceFiles } from "../src/files.js";

const bridge = `import {createInterface} from 'node:readline';
let session='session-1';let prompt;let writeId=100;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const response=(id,result)=>send({jsonrpc:'2.0',id,result});
const update=text=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
for await(const line of createInterface({input:process.stdin})){
 const message=JSON.parse(line);
 if(message.method==='initialize')response(message.id,{protocolVersion:1});
 else if(message.method==='session/new')response(message.id,{sessionId:session});
 else if(message.method==='session/prompt'){
  prompt=message.id;
  if(process.argv[2]==='malformed'){process.stdout.write('invalid JSON\\n');continue;}
  if(process.argv[2]==='overflow'){process.stdout.write('x'.repeat(2200000));continue;}
  if(process.argv[2]==='stall')continue;
  if(process.argv[2]==='texttool'){update(String.fromCharCode(96).repeat(3)+'typed-sql-tool'+String.fromCharCode(10)+JSON.stringify({file:'playground/from-text.sql',source:'select 42;'} )+String.fromCharCode(10)+String.fromCharCode(96).repeat(3));response(prompt,{stopReason:'end_turn'});continue;}
  update('I can inspect your selected context. ');
  if(process.argv[2]==='tool')send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:session,path:process.cwd()+'/playground/agent-tool.sql',content:'select id from public.accounts;\\n'}});
  else if(process.argv[2]==='escape')send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:session,path:process.cwd()+'/../outside.sql',content:'select 1'}});
  else{update('Ready.');response(prompt,{stopReason:'end_turn'});}
 }
 else if(message.id===writeId){update(message.error?'Proposal rejected.':'Tool saved for explicit execution.');response(prompt,{stopReason:'end_turn'});}
}
`;
const api = (agents: AgentRoutes, route: string, body?: Record<string, unknown>) =>
  agents.handle(new URL(`http://localhost/api/agents${route}`), body);
async function waitFor(agents: AgentRoutes, id: string, condition: (value: AgentConversation) => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = (await api(agents, `/conversation?id=${id}`)) as AgentConversation;
    if (condition(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Agent did not reach expected state");
}
async function fixture(
  action: (root: string, agents: AgentRoutes, files: WorkspaceFiles) => Promise<void>,
  mode = "normal",
) {
  const root = await mkdtemp(join(tmpdir(), "typed-sql-agents-"));
  await mkdir(join(root, "playground"));
  await writeFile(join(root, "bridge.mjs"), bridge);
  const files = new WorkspaceFiles(root, ["playground"], ["playground"]);
  const agents = new AgentRoutes({
    files,
    trusted: () => true,
    configDirectory: join(root, "user-config"),
    timeoutMs: 4000,
  });
  try {
    await api(agents, "/configure", {
      profile: { id: "local", name: "Local ACP", command: process.execPath, args: [join(root, "bridge.mjs"), mode] },
    });
    await action(root, agents, files);
  } finally {
    await agents.close();
    await rm(root, { recursive: true, force: true });
  }
}
await describe("local ACP agents and reviewed repository tools", async () => {
  await it("persists private user profiles and per-project conversations without exposing command arguments", async () =>
    fixture(async (root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      const state = (await api(agents, "")) as { profiles: Record<string, unknown>[] };
      strict.equal(state.profiles[0]?.args, undefined);
      strict.equal((await stat(join(root, "user-config/agents.json"))).mode & 0o077, 0);
      const source = await files.save("playground/query.sql", "select 1;", null);
      await api(agents, "/prompt", {
        conversationId: created.id,
        message: "Explain this query",
        context: { source: { ...source, source: "select 1;" }, schema: { tables: ["accounts"] } },
      });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.status, "idle");
      strict.equal(done.messages[1]?.text, "I can inspect your selected context. Ready.");
      const reopened = new AgentRoutes({ files, trusted: () => true, configDirectory: join(root, "user-config") });
      try {
        strict.deepEqual(await api(reopened, `/conversation?id=${created.id}`), done);
      } finally {
        await reopened.close();
      }
    }));
  await it("requires explicit review to write a tool into the repository and never executes it", async () =>
    fixture(async (root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Create a query tool" });
      const pending = await waitFor(agents, created.id, (value) => value.proposals.length === 1);
      strict.equal(pending.proposals[0]?.status, "pending");
      await strict.rejects(readFile(join(root, "playground/agent-tool.sql")), { code: "ENOENT" });
      await api(agents, "/proposal", {
        conversationId: created.id,
        proposalId: pending.proposals[0]!.id,
        action: "accept",
      });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.status, "idle");
      strict.equal(done.proposals[0]?.status, "accepted");
      strict.equal((await files.read("playground/agent-tool.sql")).source, "select id from public.accounts;\n");
    }, "tool"));
  await it("rejects stale acceptance and preserves a concurrently created repository file", async () =>
    fixture(async (_root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Create a query tool" });
      const pending = await waitFor(agents, created.id, (value) => value.proposals.length === 1);
      await files.save("playground/agent-tool.sql", "select 'user';", null);
      await strict.rejects(
        api(agents, "/proposal", {
          conversationId: created.id,
          proposalId: pending.proposals[0]!.id,
          action: "accept",
        }),
        /changed on disk/,
      );
      strict.equal((await files.read("playground/agent-tool.sql")).source, "select 'user';");
      await api(agents, "/proposal", {
        conversationId: created.id,
        proposalId: pending.proposals[0]!.id,
        action: "reject",
      });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.status, "idle");
    }, "tool"));
  await it("keeps agent filesystem requests inside configured roots", async () =>
    fixture(async (_root, agents) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Try a path" });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.proposals.length, 0);
      strict.match(done.messages[1]!.text, /rejected/);
    }, "escape"));
  for (const mode of ["malformed", "overflow"])
    await it(`fails closed for ${mode} protocol output`, async () =>
      fixture(async (_root, agents) => {
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Hello" });
        const done = await waitFor(agents, created.id, (value) => value.status !== "running");
        strict.equal(done.status, "failed");
        strict.match(done.error!, /output|JSON-RPC|oversized/);
      }, mode));
  await it("cancels a live process and persists its terminal state", async () =>
    fixture(async (_root, agents) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Keep running" });
      await api(agents, "/cancel", { conversationId: created.id });
      const done = await waitFor(agents, created.id, (value) => value.status === "cancelled");
      strict.equal(done.status, "cancelled");
    }, "stall"));
  await it("rejects source attachments that changed after the user selected them", async () =>
    fixture(async (_root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      const source = await files.save("playground/source.sql", "select 1;", null);
      await strict.rejects(
        api(agents, "/prompt", {
          conversationId: created.id,
          message: "Explain",
          context: { source: { file: source.file, revision: source.revision, source: "select 2;" } },
        }),
        /Save and reload/,
      );
      strict.equal(((await api(agents, `/conversation?id=${created.id}`)) as AgentConversation).status, "idle");
    }));
  await it("does not replay pending file changes when reopening a persisted running conversation", async () =>
    fixture(async (root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Create a query tool" });
      await waitFor(agents, created.id, (value) => value.proposals.length === 1);
      const reopened = new AgentRoutes({ files, trusted: () => true, configDirectory: join(root, "user-config") });
      try {
        const restored = (await api(reopened, `/conversation?id=${created.id}`)) as AgentConversation;
        strict.equal(restored.status, "cancelled");
        strict.equal(restored.proposals[0]?.status, "rejected");
        await strict.rejects(files.read("playground/agent-tool.sql"), { code: "ENOENT" });
      } finally {
        await reopened.close();
      }
    }, "tool"));
  await it("captures a text-only ACP agent tool as a reviewable proposal after its turn", async () =>
    fixture(async (_root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Write a SQL tool" });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.status, "idle");
      strict.equal(done.proposals[0]?.status, "pending");
      await strict.rejects(files.read("playground/from-text.sql"), { code: "ENOENT" });
      await api(agents, "/proposal", {
        conversationId: created.id,
        proposalId: done.proposals[0]!.id,
        action: "accept",
      });
      strict.equal((await files.read("playground/from-text.sql")).source, "select 42;");
    }, "texttool"));
  await it("requires project trust before configuration or prompting", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-agent-trust-"));
    const agents = new AgentRoutes({
      files: new WorkspaceFiles(root, ["playground"], ["playground"]),
      trusted: () => false,
      configDirectory: join(root, "user"),
    });
    try {
      await strict.rejects(api(agents, "/configure", { profile: {} }), /Trust this local project/);
    } finally {
      await agents.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
