import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { command, consumer, server } from "../build/src/consumer.mjs";

const artifacts = resolve("artifacts/playground-ui/agent-browser");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const evidence = { node: process.version, cases: [], errors: [], screenshots: [] };
let fixture, host, browser, page;
const check = (name, extra = {}) => {
  evidence.cases.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
async function shot(locator, name) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box);
  await page.screenshot({
    path: join(artifacts, `${name}.png`),
    animations: "disabled",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(700, box.width),
      height: Math.min(320, box.height),
    },
  });
  evidence.screenshots.push(`${name}.png`);
}
try {
  evidence.sourceHead = (await command(process.cwd(), "git", ["rev-parse", "HEAD"])).output.trim();
  fixture = await consumer(
    ["playwright", "typescript", "@types/node"],
    ["@typed-sql/playground", "@typed-sql/postgres"],
  );
  await mkdir(join(fixture.directory, ".git"));
  const root = await fixture.project("agent-ui");
  await mkdir(join(root, "playground"));
  await writeFile(
    join(root, "schema.json"),
    JSON.stringify({
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        "public.accounts": {
          name: "accounts",
          schema: "public",
          columns: { id: { name: "id", databaseType: "integer", tsType: "number", nullable: false } },
        },
      },
    }),
  );
  await writeFile(
    join(root, "typed-sql.config.mjs"),
    "import{postgres}from'@typed-sql/postgres';export default{dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],playground:{readRoots:['playground'],writeRoots:['playground']}};\n",
  );
  const original = "select 1 as original_value;\n";
  await writeFile(join(root, "playground/existing.sql"), original);
  await copyFile(resolve("e2e/playground-ui/fixtures/agent-acp.mjs"), join(root, "fake-agent.mjs"));
  await writeFile(
    join(root, "host.mjs"),
    "import{startPlayground}from'@typed-sql/playground';const host=await startPlayground({config:'typed-sql.config.mjs',port:Number(process.env.PORT)});console.log('AGENT_UI '+host.url);process.on('SIGTERM',()=>void host.close().then(()=>process.exit(0)));\n",
  );
  host = await server(root, ["host.mjs"], { XDG_CONFIG_HOME: join(root, "private-xdg") });
  assert.equal((await host.fetch("/")).status, 200);
  const url = /AGENT_UI (http:\/\/[^\s]+)/u.exec(host.output())?.[1];
  assert.ok(url);
  const require = createRequire(join(fixture.directory, "package.json")),
    { chromium } = require("playwright");
  if (!process.env.TYPED_SQL_BROWSER_EXECUTABLE && process.env.TYPED_SQL_BROWSER_INSTALLED !== "1")
    await fixture.command(root, "pnpm", ["exec", "playwright", "install", "chromium"], { timeout: 300000 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TYPED_SQL_BROWSER_EXECUTABLE ? { executablePath: process.env.TYPED_SQL_BROWSER_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  page.setDefaultTimeout(25000);
  page.on("pageerror", (error) => evidence.errors.push(String(error)));
  await page.goto(url);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true }),
    input = page.getByRole("combobox", { name: "Search files and commands", exact: true });
  async function invoke(query, label = query) {
    await page.keyboard.press("ControlOrMeta+k");
    await palette.waitFor();
    await input.fill(query);
    await palette
      .getByRole("option")
      .filter({ has: page.getByText(label, { exact: true }) })
      .click();
    await palette.waitFor({ state: "detached" });
  }
  await page.getByRole("navigation", { name: "Project files", exact: true }).waitFor();
  const trust = page.getByRole("dialog", { name: "Enable project execution", exact: true });
  await invoke(">Enable trusted project execution", "Enable trusted project execution");
  await trust.getByRole("button", { name: "Enable for this session", exact: true }).click();
  await trust.waitFor({ state: "detached" });
  await invoke("playground/existing.sql");
  await page.getByRole("textbox", { name: "Query source editor", exact: true }).waitFor();
  await invoke(">Open agent", "Open agent");
  const config = page.locator(".agent-config"),
    profile = page.getByRole("combobox", { name: "Agent profile", exact: true }),
    conversations = page.getByRole("combobox", { name: "Agent conversation", exact: true }),
    composer = page.getByRole("textbox", { name: "Message local agent", exact: true }),
    messages = page.getByRole("log", { name: "Agent conversation", exact: true });
  await config.getByRole("combobox", { name: "Agent preset", exact: true }).selectOption("codex");
  assert.equal(await config.getByRole("textbox", { name: "Agent name", exact: true }).inputValue(), "Codex");
  assert.equal(await config.getByRole("textbox", { name: "Agent executable", exact: true }).inputValue(), "codex-acp");
  assert.equal(await config.getByRole("textbox", { name: "Agent arguments", exact: true }).inputValue(), "[]");
  await shot(config, "codex-preset");
  await config.getByRole("button", { name: "Save profile", exact: true }).click();
  await config.waitFor({ state: "detached" });
  assert.equal(await profile.inputValue(), "codex");
  check("Codex preset saves explicit codex-acp executable and empty arguments without starting a process");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await config.getByRole("combobox", { name: "Agent preset", exact: true }).selectOption("custom");
  await config.getByRole("textbox", { name: "Agent name", exact: true }).fill("Fixture ACP");
  await config.getByRole("textbox", { name: "Agent executable", exact: true }).fill(process.execPath);
  await config
    .getByRole("textbox", { name: "Agent arguments", exact: true })
    .fill(JSON.stringify([join(root, "fake-agent.mjs")]));
  await config.getByRole("button", { name: "Save profile", exact: true }).click();
  await config.waitFor({ state: "detached" });
  assert.equal(await profile.inputValue(), "fixture-acp");
  await assert.rejects(readFile(join(root, "fake-agent-trace.jsonl")), { code: "ENOENT" });
  await page.reload();
  await profile.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Agent profile"]').value === "fixture-acp");
  check("native form input events persist the configured profile and selected profile ID across reload");
  await invoke("playground/existing.sql");
  await page.getByRole("textbox", { name: "Query source editor", exact: true }).waitFor();
  await invoke(">Open agent", "Open agent");
  await page.getByRole("checkbox", { name: "Schema", exact: true }).check();
  const workspaceTools = page.getByRole("checkbox", { name: "Workspace tools", exact: true });
  assert.equal(await workspaceTools.isChecked(), false);
  await workspaceTools.check();
  const promptRequest = page.waitForRequest((request) => request.url().endsWith("/api/agents/prompt"));
  await composer.fill("stream response");
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  const sent = (await promptRequest).postDataJSON();
  assert.equal(sent.workspaceTools, true);
  assert.equal(sent.context.source.file, "playground/existing.sql");
  assert.ok(sent.context.schema.tables.length);
  await messages.getByText(/Partial response from/u).waitFor();
  assert.doesNotMatch(await messages.textContent(), /Completed response/u);
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  await writeFile(join(root, "complete-stream"), "continue");
  await messages.getByText(/Completed response/u).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  const streamId = await conversations.inputValue();
  assert.ok(streamId);
  const toolCall = messages.getByRole("status", { name: "Workspace tool: Get schema", exact: true });
  await toolCall.waitFor();
  assert.match(await toolCall.textContent(), /Completed/u);
  await shot(toolCall, "workspace-tool-progress");
  check(
    "explicit workspace-tools opt-in reaches the real scoped MCP broker and renders tool-call completion without arguments or outputs",
  );
  check("real ACP chunks stream before completion and include only chosen saved source/schema context");
  await invoke("playground/existing.sql");
  await page.getByRole("textbox", { name: "Query source editor", exact: true }).waitFor();
  await invoke(">Open agent", "Open agent");
  await messages.getByText(/Completed response/u).waitFor();
  assert.equal(await conversations.inputValue(), streamId);
  assert.equal(
    await page.getByRole("checkbox", { name: "Workspace tools", exact: true }).isChecked(),
    false,
    "Tool permission is not silently restored with conversation IDs",
  );
  await page.reload();
  await messages.getByText(/Completed response/u).waitFor();
  assert.equal(await profile.inputValue(), "fixture-acp");
  assert.equal(await conversations.inputValue(), streamId);
  const selection = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => key.startsWith("typed-sql-agent-selection-v1:")),
  );
  assert.equal(selection.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(selection[0][1])).sort(), ["conversationId", "profileId"]);
  check(
    "switching tabs and reloading restores selected conversation and messages while browser storage holds only IDs",
  );
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".agent-message").length === 0);
  const rejectedId = await conversations.inputValue();
  assert.notEqual(rejectedId, streamId);
  await composer.fill("reject proposal");
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  const rejected = page.locator(".agent-proposal.pending");
  await rejected.waitFor();
  const rejectedPath = await rejected.locator("header strong").textContent();
  assert.equal(await rejected.getByRole("button", { name: "Apply reviewed change", exact: true }).isEnabled(), false);
  await rejected.getByRole("button", { name: "Review diff", exact: true }).click();
  await rejected.locator(".proposal-diff").waitFor();
  assert.match(await rejected.locator(".proposal-diff").textContent(), /new file/u);
  assert.match(await rejected.locator(".proposal-diff").textContent(), /select 42/u);
  for (const mode of ["light", "dark"]) {
    await invoke(`>Theme: ${mode[0].toUpperCase() + mode.slice(1)}`, `Theme: ${mode[0].toUpperCase() + mode.slice(1)}`);
    await shot(rejected, `proposal-${mode}`);
  }
  await page.setViewportSize({ width: 560, height: 900 });
  await rejected.scrollIntoViewIfNeeded();
  const geometry = await rejected.evaluate((node) => ({
    width: node.clientWidth,
    scroll: node.scrollWidth,
    parent: node.parentElement.clientWidth,
    parentScroll: node.parentElement.scrollWidth,
  }));
  assert.equal(geometry.scroll, geometry.width);
  assert.equal(geometry.parentScroll, geometry.parent);
  const panelGeometry = await page
    .locator(".agent-workspace")
    .evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
  assert.equal(panelGeometry.scroll, panelGeometry.width);
  await shot(rejected, "proposal-narrow");
  await rejected.getByRole("button", { name: "Reject", exact: true }).click();
  await page.locator(".agent-proposal.rejected").waitFor();
  assert.equal(
    await page.locator(".agent-proposal.rejected").getByRole("button", { name: "Open file", exact: true }).count(),
    0,
  );
  await assert.rejects(readFile(join(root, rejectedPath)), { code: "ENOENT" });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 900 });
  check(
    "reviewed rejection leaves a new file absent and long proposal paths/code stay within narrow light/dark panels",
    geometry,
  );
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".agent-message").length === 0);
  const acceptedId = await conversations.inputValue();
  await composer.fill("accept proposal");
  await composer.press("ControlOrMeta+Enter");
  const accepted = page.locator(".agent-proposal.pending");
  await accepted.waitFor();
  await accepted.getByRole("button", { name: "Review diff", exact: true }).click();
  assert.match(await accepted.locator(".proposal-diff").textContent(), /original_value/u);
  assert.equal(await readFile(join(root, "playground/existing.sql"), "utf8"), original);
  await accepted.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await page.locator(".agent-proposal.accepted").waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  assert.match(await readFile(join(root, "playground/existing.sql"), "utf8"), /^select 42 as reviewed_value;/u);
  await page.locator(".agent-proposal.accepted").getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("textbox", { name: "Query source editor", exact: true }).waitFor();
  assert.match(await page.locator(".cm-content").textContent(), /reviewed_value/u);
  check("explicit reviewed acceptance writes the actual file and opens its source without executing SQL");
  await invoke(">Open agent", "Open agent");
  await page.locator(".agent-proposal.accepted").waitFor();
  assert.equal(await conversations.inputValue(), acceptedId);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let interceptedResolve;
  const intercepted = new Promise((resolve) => {
    interceptedResolve = resolve;
  });
  await page.route("**/api/agents/conversation?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("id") !== streamId) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    interceptedResolve();
    await held;
    await route.fulfill({ response });
  });
  await conversations.selectOption("");
  await conversations.selectOption(streamId);
  await intercepted;
  await conversations.selectOption(acceptedId);
  await page.locator(".agent-proposal.accepted").waitFor();
  release();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await conversations.inputValue(), acceptedId);
  await page.unroute("**/api/agents/conversation?*");
  check("late conversation responses cannot replace a newer selected conversation");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".agent-message").length === 0);
  await composer.fill("cancel proposal");
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  const cancelled = page.locator(".agent-proposal.pending");
  await cancelled.waitFor();
  const cancelledPath = await cancelled.locator("header strong").textContent();
  const cancelResponse = page.waitForResponse((response) => response.url().endsWith("/api/agents/cancel"));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  assert.equal((await cancelResponse).status(), 200);
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  await assert.rejects(readFile(join(root, cancelledPath)), { code: "ENOENT" });
  check("Stop cancels an ACP turn with a pending proposal and never writes its file");
  await conversations.selectOption(streamId);
  await messages.getByText(/Completed response/u).waitFor();
  await invoke(">Disable trusted project execution", "Disable trusted project execution");
  await page.waitForFunction(() => document.querySelectorAll(".agent-message").length === 0);
  const transcriptRequests = [];
  const recordRequest = (request) => {
    if (request.url().includes("/api/agents/conversation?")) transcriptRequests.push(request.url());
  };
  page.on("request", recordRequest);
  await conversations.selectOption(streamId);
  await trust.waitFor();
  assert.equal(transcriptRequests.length, 0);
  await trust.getByRole("button", { name: "Enable for this session", exact: true }).click();
  await trust.waitFor({ state: "detached" });
  await messages.getByText(/Completed response/u).waitFor();
  assert.equal(await conversations.inputValue(), streamId);
  assert.ok(transcriptRequests.length);
  page.off("request", recordRequest);
  check("saved conversation selection waits for project trust before requesting the full transcript");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("typed-sql-agent-selection-v1:"));
    localStorage.setItem(
      key,
      JSON.stringify({ profileId: "fixture-acp", conversationId: "not-a-current-project-conversation" }),
    );
  });
  const invalidTranscriptRequests = [];
  const invalidRequest = (request) => {
    if (request.url().includes("/api/agents/conversation?")) invalidTranscriptRequests.push(request.url());
  };
  page.on("request", invalidRequest);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[aria-label="Agent profile"]').value === "fixture-acp");
  assert.equal(await conversations.inputValue(), "");
  assert.equal(await messages.locator(".agent-message").count(), 0);
  assert.equal(invalidTranscriptRequests.length, 0);
  page.off("request", invalidRequest);
  check("saved conversation IDs outside the current project are discarded before transcript access");
  const state = await page.evaluate(
    async () =>
      await (
        await fetch("/api/state", { headers: { "x-typed-sql-session": sessionStorage.getItem("typed-sql-session") } })
      ).json(),
  );
  assert.equal(state.runs.length, 0, "Accepting a proposed SQL file never executes it");
  const trace = (await readFile(join(root, "fake-agent-trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(trace.filter((entry) => entry.action === "prompt").length, 4);
  assert.ok(trace.some((entry) => entry.action === "read" && entry.success));
  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(artifacts, "results.json"), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await host?.close();
  await fixture?.close();
}
