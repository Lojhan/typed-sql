import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  type AgentConversation,
  AgentRoutes,
  type AgentWorkspaceTools,
  agentConfigurationDirectory,
} from "../src/agents.js";
import { WorkspaceFiles } from "../src/files.js";

const bridge = `import {createInterface} from 'node:readline';
let session='session-1';let prompt;let writeId=100;let mcpCount=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const response=(id,result)=>send({jsonrpc:'2.0',id,result});
const update=text=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
for await(const line of createInterface({input:process.stdin})){
 const message=JSON.parse(line);
 if(message.method==='initialize')response(message.id,{protocolVersion:1});
 else if(message.method==='session/new'){mcpCount=message.params.mcpServers.length;response(message.id,{sessionId:session});}
 else if(message.method==='session/prompt'){
  prompt=message.id;
  if(process.argv[2]==='malformed'){process.stdout.write('invalid JSON\\n');continue;}
  if(process.argv[2]==='overflow'){process.stdout.write('x'.repeat(2200000));continue;}
  if(process.argv[2]==='stall')continue;
  if(process.argv[2]==='mcp'){update(JSON.stringify({servers:mcpCount,prompt:message.params.prompt[0].text}));response(prompt,{stopReason:'end_turn'});continue;}
  if(process.argv[2]==='crash'){process.exit(3);}
  if(process.argv[2]==='nul'){update('invalid'+String.fromCharCode(0));response(prompt,{stopReason:'end_turn'});continue;}
  if(process.argv[2].startsWith('stop-')){update('Partial reply');response(prompt,{stopReason:process.argv[2].slice(5)});continue;}
  if(process.argv[2]==='permission'){send({jsonrpc:'2.0',id:writeId,method:'session/request_permission',params:{sessionId:session,options:[{optionId:'allow',kind:'allow_once',name:'Allow'},{optionId:'deny',kind:'reject_once',name:'Reject'}]}});continue;}
  if(process.argv[2]==='read'){send({jsonrpc:'2.0',id:writeId,method:'fs/read_text_file',params:{sessionId:session,path:process.cwd()+'/playground/source.sql',line:2,limit:1}});continue;}
  if(process.argv[2]==='requests'){for(let i=0;i<20;i++)send({jsonrpc:'2.0',id:writeId+i,method:'fs/write_text_file',params:{sessionId:session,path:process.cwd()+'/playground/agent-tool.sql',content:'select 1;'}});continue;}
  if(process.argv[2]==='context'){update(message.params.prompt[0].text);response(prompt,{stopReason:'end_turn'});continue;}
  if(process.argv[2]==='texttool'){update(String.fromCharCode(96).repeat(3)+'typed-sql-tool'+String.fromCharCode(10)+JSON.stringify({file:'playground/from-text.sql',source:'select 42;'} )+String.fromCharCode(10)+String.fromCharCode(96).repeat(3));response(prompt,{stopReason:'end_turn'});continue;}
  update('I can inspect your selected context. ');
  if(process.argv[2]==='tool')send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:session,path:process.cwd()+'/playground/agent-tool.sql',content:'select id from public.accounts;\\n'}});
  else if(process.argv[2]==='escape')send({jsonrpc:'2.0',id:writeId,method:'fs/write_text_file',params:{sessionId:session,path:process.cwd()+'/../outside.sql',content:'select 1'}});
  else{update('Ready.');response(prompt,{stopReason:'end_turn'});}
 }
 else if(message.id===writeId){if(process.argv[2]==='read'||process.argv[2]==='permission')update(JSON.stringify(message.result));else update(message.error?'Proposal rejected.':'Tool saved for explicit execution.');response(prompt,{stopReason:'end_turn'});}
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
  options: { workspaceTools?: AgentWorkspaceTools; timeoutMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "typed-sql-agents-"));
  await mkdir(join(root, "playground"));
  await writeFile(join(root, "bridge.mjs"), bridge);
  const files = new WorkspaceFiles(root, ["playground"], ["playground"]);
  const agents = new AgentRoutes({
    files,
    trusted: () => true,
    configDirectory: join(root, "user-config"),
    timeoutMs: options.timeoutMs ?? 4000,
    sqlModule: "@typed-sql/postgres",
    ...(options.workspaceTools === undefined ? {} : { workspaceTools: options.workspaceTools }),
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
  await it("keeps user storage outside the project when XDG_CONFIG_HOME is relative or missing", () => {
    const home = join(tmpdir(), "agent-home-fixture");
    const absolute = join(tmpdir(), "agent-xdg-fixture");
    const fallback = join(home, ".config", "typed-sql", "playground");
    strict.equal(agentConfigurationDirectory(undefined, home), fallback);
    strict.equal(agentConfigurationDirectory("", home), fallback);
    strict.equal(agentConfigurationDirectory("relative-config", home), fallback);
    strict.equal(agentConfigurationDirectory("./repo-settings", home), fallback);
    strict.equal(agentConfigurationDirectory(absolute, home), join(absolute, "typed-sql", "playground"));
  });

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
      await agents.close();
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
      const pending = await waitFor(agents, created.id, (value) => value.proposals.length === 1);
      const storage = join(root, "user-config", "conversations");
      const deadline = Date.now() + 8000;
      for (;;) {
        const documents = await readdir(storage);
        const source = documents[0] ? await readFile(join(storage, documents[0]), "utf8") : "";
        if (source.includes(pending.proposals[0]!.id)) break;
        if (Date.now() >= deadline) throw new Error("Pending proposal was not durably persisted");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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
  for (const reason of ["cancelled", "refusal", "max_tokens", "max_turn_requests", "invalid"])
    await it(`preserves ACP stop reason ${reason} instead of reporting success`, async () =>
      fixture(async (_root, agents) => {
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Please continue" });
        const done = await waitFor(agents, created.id, (value) => value.status !== "running");
        strict.equal(done.status, reason === "cancelled" ? "cancelled" : "failed");
        if (reason !== "invalid") strict.equal(done.stopReason, reason);
        else strict.match(done.error!, /stop reason/u);
      }, `stop-${reason}`));
  await it("rejects native permission once without granting it or cancelling the whole session", async () =>
    fixture(async (_root, agents) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Request permission" });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.status, "idle");
      strict.match(done.messages[1]!.text, /"outcome":"selected"/u);
      strict.match(done.messages[1]!.text, /"optionId":"deny"/u);
    }, "permission"));
  await it("honors ACP one-based line ranges without exposing other lines", async () =>
    fixture(async (_root, agents, files) => {
      await files.save("playground/source.sql", "first\r\nsecond\r\nthird\r\n", null);
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Read the selected line" });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.equal(done.messages[1]!.text, JSON.stringify({ content: "second\r\n" }));
    }, "read"));
  await it("reserves one prompt per conversation after asynchronous context validation", async () =>
    fixture(async (_root, agents, files) => {
      const source = await files.save("playground/source.sql", "select 1;", null);
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      const request = {
        conversationId: created.id,
        message: "Wait",
        context: { source: { ...source, source: "select 1;" } },
      };
      const outcomes = await Promise.allSettled([api(agents, "/prompt", request), api(agents, "/prompt", request)]);
      strict.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
      strict.equal(outcomes.filter((value) => value.status === "rejected").length, 1);
      const current = (await api(agents, `/conversation?id=${created.id}`)) as AgentConversation;
      strict.equal(current.messages.length, 1);
      await api(agents, "/cancel", { conversationId: created.id });
    }, "stall"));
  await it("enforces the two-turn limit during pending process startup", async () =>
    fixture(async (_root, agents) => {
      const conversations: AgentConversation[] = [];
      for (let i = 0; i < 3; i++)
        conversations.push((await api(agents, "/new", { profileId: "local" })) as AgentConversation);
      const outcomes = await Promise.allSettled(
        conversations.map((conversation) =>
          api(agents, "/prompt", { conversationId: conversation.id, message: "Wait" }),
        ),
      );
      strict.equal(outcomes.filter((value) => value.status === "fulfilled").length, 2);
      strict.equal(outcomes.filter((value) => value.status === "rejected").length, 1);
      for (const conversation of conversations) await api(agents, "/cancel", { conversationId: conversation.id });
    }, "stall"));
  for (const mode of ["crash", "requests", "nul"])
    await it(`fails closed for ${mode} and settles turn cleanup`, async () =>
      fixture(async (_root, agents) => {
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Try" });
        const done = await waitFor(agents, created.id, (value) => value.status !== "running");
        strict.equal(done.status, "failed");
        strict.ok(done.proposals.every((proposal) => proposal.status !== "pending"));
      }, mode));
  await it("does not create an orphan approval if cancelled during an asynchronous file request", async () =>
    fixture(async (_root, agents, files) => {
      const originalRead = files.read.bind(files);
      let entered!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      files.read = async (file) => {
        if (file === "playground/agent-tool.sql") {
          entered();
          await gate;
        }
        return originalRead(file);
      };
      try {
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Propose" });
        await started;
        await api(agents, "/cancel", { conversationId: created.id });
        finish();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const done = (await api(agents, `/conversation?id=${created.id}`)) as AgentConversation;
        strict.equal(done.status, "cancelled");
        strict.ok(done.proposals.every((proposal) => proposal.status !== "pending"));
      } finally {
        finish();
        files.read = originalRead;
      }
    }, "tool"));
  await it("shares only selected context and rejects oversized schema/result attachments", async () =>
    fixture(async (_root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      const source = await files.save("playground/source.sql", "select 7;", null);
      await strict.rejects(
        api(agents, "/prompt", {
          conversationId: created.id,
          message: "Explain",
          context: { result: { value: "x".repeat(256 * 1024) } },
        }),
        /smaller context/u,
      );
      await api(agents, "/prompt", {
        conversationId: created.id,
        message: "Explain",
        context: { source: { ...source, source: "select 7;" }, result: { rows: [[7]] } },
      });
      const done = await waitFor(agents, created.id, (value) => value.status !== "running");
      strict.match(done.messages[1]!.text, /select 7/u);
      strict.match(done.messages[1]!.text, /"rows":\[\[7\]\]/u);
      strict.ok(!done.messages[1]!.text.includes('"schema":'));
    }, "context"));
  await it("keeps an accepted proposal decision atomic against a simultaneous rejection", async () =>
    fixture(async (_root, agents, files) => {
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await api(agents, "/prompt", { conversationId: created.id, message: "Create" });
      const pending = await waitFor(agents, created.id, (value) => value.proposals.length === 1);
      const originalSave = files.save.bind(files);
      let started!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      files.save = async (file, source, revision) => {
        started();
        await gate;
        return originalSave(file, source, revision);
      };
      try {
        const accepting = api(agents, "/proposal", {
          conversationId: created.id,
          proposalId: pending.proposals[0]!.id,
          action: "accept",
        });
        await entered;
        await strict.rejects(
          api(agents, "/proposal", {
            conversationId: created.id,
            proposalId: pending.proposals[0]!.id,
            action: "reject",
          }),
          /no longer pending/u,
        );
        finish();
        await accepting;
        const done = await waitFor(agents, created.id, (value) => value.status !== "running");
        strict.equal(done.proposals[0]!.status, "accepted");
        strict.equal((await files.read("playground/agent-tool.sql")).source, "select id from public.accounts;\n");
      } finally {
        finish();
        files.save = originalSave;
      }
    }, "tool"));
  await it("keeps workspace tools opt-in and rejects unsupported enablement before a turn starts", async () =>
    fixture(async (_root, agents) => {
      const listing = (await api(agents, "")) as { workspaceToolsAvailable: boolean };
      strict.equal(listing.workspaceToolsAvailable, false);
      const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
      await strict.rejects(
        api(agents, "/prompt", { conversationId: created.id, message: "Tools", workspaceTools: true }),
        /does not expose/u,
      );
      const unchanged = (await api(agents, `/conversation?id=${created.id}`)) as AgentConversation;
      strict.equal(unchanged.messages.length, 0);
    }));
  await it("scopes explicit MCP tools to one turn, persists safe tool evidence and leaves file proposals reviewable", async () => {
    let opens = 0;
    let closes = 0;
    let signal: AbortSignal | undefined;
    const tools: AgentWorkspaceTools = {
      open: async (options) => {
        opens++;
        signal = options.signal;
        const running = {
          id: "call-1",
          name: "workspace_schema",
          state: "running" as const,
          args: "secret-argument",
          output: "secret-result",
        };
        await options.onToolCall?.(running);
        await options.onToolCall?.({ id: "call-1", name: "workspace_schema", state: "completed" });
        await options.propose({
          file: "playground/from-mcp.sql",
          source: "select 42;",
          revision: null,
          description: "Reviewed MCP tool",
        });
        return {
          mcpServers: [
            {
              type: "http",
              name: "typed-sql",
              url: "http://127.0.0.1:1/api/agent-tools",
              headers: [{ name: "Authorization", value: "Bearer private-tool-cap" }],
            },
          ],
          close: async () => {
            closes++;
          },
        };
      },
    };
    await fixture(
      async (root, agents, files) => {
        const listing = (await api(agents, "")) as { workspaceToolsAvailable: boolean };
        strict.equal(listing.workspaceToolsAvailable, true);
        const disabled = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: disabled.id, message: "No tools" });
        await waitFor(agents, disabled.id, (value) => value.status !== "running");
        strict.equal(opens, 0);
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Inspect", workspaceTools: true });
        const done = await waitFor(agents, created.id, (value) => value.status !== "running");
        strict.equal(done.status, "idle");
        strict.equal(opens, 1);
        strict.equal(signal?.aborted, true);
        strict.equal(done.toolCalls?.[0]?.name, "workspace_schema");
        strict.equal(done.toolCalls?.[0]?.state, "completed");
        strict.equal(done.proposals[0]?.status, "pending");
        await strict.rejects(files.read("playground/from-mcp.sql"), { code: "ENOENT" });
        strict.match(done.messages[1]!.text, /"servers":1/u);
        strict.match(done.messages[1]!.text, /databaseForRun\(\)\.all/u);
        strict.ok(!JSON.stringify(done).includes("private-tool-cap"));
        strict.ok(!JSON.stringify(done).includes("secret-argument"));
        strict.ok(!JSON.stringify(done).includes("secret-result"));
        await agents.close();
        strict.equal(closes, 1);
        const reopened = new AgentRoutes({ files, trusted: () => true, configDirectory: join(root, "user-config") });
        try {
          const restored = (await api(reopened, `/conversation?id=${created.id}`)) as AgentConversation;
          strict.equal(restored.toolCalls?.[0]?.state, "completed");
          strict.equal(restored.proposals[0]?.status, "pending");
          await api(reopened, "/proposal", {
            conversationId: created.id,
            proposalId: restored.proposals[0]!.id,
            action: "accept",
          });
          strict.equal((await files.read("playground/from-mcp.sql")).source, "select 42;");
        } finally {
          await reopened.close();
        }
      },
      "mcp",
      { workspaceTools: tools },
    );
  });
  await it("revokes scoped tools on cancellation and rejects stale proposal revisions", async () => {
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let scope: Parameters<AgentWorkspaceTools["open"]>[0] | undefined;
    let closes = 0;
    const tools: AgentWorkspaceTools = {
      open: async (options) => {
        scope = options;
        opened();
        return {
          mcpServers: [],
          close: async () => {
            closes++;
          },
        };
      },
    };
    await fixture(
      async (_root, agents, files) => {
        const existing = await files.save("playground/source.sql", "select 1;", null);
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Wait", workspaceTools: true });
        await ready;
        await strict.rejects(
          scope!.propose({ file: existing.file, source: "select 2;", revision: null }),
          /changed since/u,
        );
        const proposal = await scope!.propose({
          file: existing.file,
          source: "select 2;",
          revision: existing.revision,
        });
        strict.equal(proposal.status, "pending");
        await scope!.onToolCall?.({ id: "pending-1", name: "workspace_query", state: "running" });
        await api(agents, "/cancel", { conversationId: created.id });
        strict.equal(scope!.signal.aborted, true);
        await strict.rejects(
          scope!.propose({ file: "playground/late.sql", source: "select 1;", revision: null }),
          /no longer active/u,
        );
        const done = (await api(agents, `/conversation?id=${created.id}`)) as AgentConversation;
        strict.equal(done.proposals[0]?.status, "rejected");
        strict.equal(done.toolCalls?.[0]?.state, "failed");
        strict.equal((await files.read(existing.file)).source, "select 1;");
        await agents.close();
        strict.equal(closes, 1);
      },
      "stall",
      { workspaceTools: tools },
    );
  });
  await it("does not hang cancellation while an optional tool lease is still opening", async () => {
    let opened!: () => void;
    const entered = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let finish!: (value: Awaited<ReturnType<AgentWorkspaceTools["open"]>>) => void;
    let closed = 0;
    const tools: AgentWorkspaceTools = {
      open: async () => {
        opened();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    };
    await fixture(
      async (_root, agents) => {
        const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
        await api(agents, "/prompt", { conversationId: created.id, message: "Wait", workspaceTools: true });
        await entered;
        await api(agents, "/cancel", { conversationId: created.id });
        await agents.close();
        finish({
          mcpServers: [],
          close: async () => {
            closed++;
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        strict.equal(closed, 1);
      },
      "stall",
      { workspaceTools: tools },
    );
  });
  await it("keeps a conversation reserved until its prior tool lease and persistence finish closing", async () => {
    let closing!: () => void;
    const entered = new Promise<void>((resolve) => {
      closing = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let opens = 0;
    const tools: AgentWorkspaceTools = {
      open: async () => {
        opens++;
        return {
          mcpServers: [],
          close: async () => {
            closing();
            await gate;
          },
        };
      },
    };
    await fixture(
      async (_root, agents) => {
        try {
          const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
          await api(agents, "/prompt", { conversationId: created.id, message: "First", workspaceTools: true });
          await entered;
          const closedModel = (await api(agents, `/conversation?id=${created.id}`)) as AgentConversation;
          strict.equal(closedModel.status, "idle");
          await strict.rejects(
            api(agents, "/prompt", { conversationId: created.id, message: "Too early", workspaceTools: true }),
            /current agent turn/u,
          );
          strict.equal(opens, 1);
          finish();
          // Once close completes, the reservation is released and a new turn can start safely.
          const deadline = Date.now() + 8000;
          for (;;) {
            try {
              await api(agents, "/prompt", { conversationId: created.id, message: "Second", workspaceTools: true });
              break;
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes("current agent turn") || Date.now() > deadline)
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          await waitFor(agents, created.id, (value) => value.status !== "running");
          strict.equal(opens, 2);
        } finally {
          finish();
        }
      },
      "normal",
      { workspaceTools: tools },
    );
  });
  for (const [mode, status, stopReason] of [
    ["normal", "idle", "end_turn"],
    ["stop-refusal", "failed", "refusal"],
    ["stop-cancelled", "cancelled", "cancelled"],
  ] as const)
    await it(`preserves ${status} outcome when closing during terminal cleanup`, async () => {
      let entered!: () => void;
      const closing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const tools: AgentWorkspaceTools = {
        open: async () => ({
          mcpServers: [],
          close: async () => {
            entered();
            await gate;
          },
        }),
      };
      await fixture(
        async (root, agents, files) => {
          try {
            const created = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
            await api(agents, "/prompt", { conversationId: created.id, message: "Explain", workspaceTools: true });
            await closing;
            const terminal = (await api(agents, "/cancel", { conversationId: created.id })) as AgentConversation;
            strict.equal(terminal.status, status);
            strict.equal(terminal.stopReason, stopReason);
            const shuttingDown = agents.close();
            finish();
            await shuttingDown;
            const reopened = new AgentRoutes({
              files,
              trusted: () => true,
              configDirectory: join(root, "user-config"),
            });
            try {
              const restored = (await api(reopened, `/conversation?id=${created.id}`)) as AgentConversation;
              strict.equal(restored.status, status);
              strict.equal(restored.stopReason, stopReason);
              strict.deepEqual(restored.messages, terminal.messages);
            } finally {
              await reopened.close();
            }
          } finally {
            finish();
          }
        },
        mode,
        { workspaceTools: tools },
      );
    });
  await it("counts a cancelled-but-closing lease against the two-turn resource limit", async () => {
    let closing!: () => void;
    const entered = new Promise<void>((resolve) => {
      closing = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const tools: AgentWorkspaceTools = {
      open: async () => ({
        mcpServers: [],
        close: async () => {
          closing();
          await gate;
        },
      }),
    };
    await fixture(
      async (_root, agents) => {
        try {
          const first = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
          await api(agents, "/prompt", { conversationId: first.id, message: "First", workspaceTools: true });
          await entered;
          await api(agents, "/cancel", { conversationId: first.id });
          const second = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
          const third = (await api(agents, "/new", { profileId: "local" })) as AgentConversation;
          const attempts = await Promise.allSettled([
            api(agents, "/prompt", { conversationId: second.id, message: "Second" }),
            api(agents, "/prompt", { conversationId: third.id, message: "Third" }),
          ]);
          strict.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
          strict.equal(attempts.filter((item) => item.status === "rejected").length, 1);
          finish();
        } finally {
          finish();
        }
      },
      "normal",
      { workspaceTools: tools },
    );
  });
});
