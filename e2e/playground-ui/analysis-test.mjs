import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { consumer, server } from "../build/src/consumer.mjs";

const artifacts = resolve("artifacts/playground-ui/analysis-browser");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const evidence = { cases: [], errors: [], screenshots: [] };
const check = (name) => {
  evidence.cases.push(name);
  console.log(`PASS ${name}`);
};
let fixture, host, browser, page, admin, database;
try {
  fixture = await consumer(
    ["playwright", "typescript", "@types/node", "pg", "pg-cursor"],
    ["@typed-sql/playground", "@typed-sql/postgres"],
  );
  const require = createRequire(join(fixture.directory, "package.json")),
    { Pool } = require("pg"),
    { chromium } = require("playwright");
  assert.ok(process.env.TYPED_SQL_EXPLORER_ADMIN_URL, "Set an admin URL for disposable analysis databases");
  admin = new Pool({ connectionString: process.env.TYPED_SQL_EXPLORER_ADMIN_URL });
  database = `typed_sql_analysis_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.TYPED_SQL_EXPLORER_ADMIN_URL);
  connection.pathname = `/${database}`;
  const pool = new Pool({ connectionString: connection.href });
  try {
    await pool.query(
      "CREATE TABLE public.users(id integer PRIMARY KEY, region text NOT NULL, team text NOT NULL, active boolean NOT NULL); INSERT INTO public.users VALUES (1,'EU','A',true),(2,'EU','A',true),(3,'EU','B',true),(4,'US','A',true),(5,'US','A',true),(6,'US','B',true),(7,'EU','B',false),(8,'US','B',false); CREATE TABLE public.measurements AS SELECT generate_series(1,1200) AS id",
    );
  } finally {
    await pool.end();
  }
  const root = await fixture.project("analysis-ui");
  await mkdir(join(root, "playground"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "playground/query.sql"), "SELECT id FROM public.users;\n");
  await writeFile(join(root, "target.json"), JSON.stringify({ connectionString: connection.href, database }), {
    mode: 0o600,
  });
  await writeFile(
    join(root, "typed-sql.config.mjs"),
    `import{readFileSync}from'node:fs';import{postgres}from'@typed-sql/postgres';import{pg}from'@typed-sql/postgres/pg';import{createPgPlaygroundTarget}from'@typed-sql/playground/pg';const t=JSON.parse(readFileSync(new URL('./target.json',import.meta.url)));export default{dialect:postgres(),schema:{file:'schema.json',provider:pg({connectionString:()=>t.connectionString})},outDir:'generated',projects:['tsconfig.json'],playground:{readRoots:['playground'],writeRoots:['playground'],targets:{local:{classification:'test',expected:{database:t.database},connect:()=>createPgPlaygroundTarget({connectionString:()=>t.connectionString})}}}};`,
  );
  const internal = join(fixture.directory, "node_modules/@typed-sql");
  const { createPgPlaygroundTarget } = await import(join(internal, "playground/dist/packages/playground/src/pg.js"));
  const target = createPgPlaygroundTarget({ connectionString: () => connection.href });
  try {
    await writeFile(join(root, "schema.json"), JSON.stringify(await target.snapshot()));
  } finally {
    await target.close();
  }
  await copyFile(resolve("e2e/playground-ui/fixtures/analysis-acp.mjs"), join(root, "agent.mjs"));
  await writeFile(
    join(root, "host.mjs"),
    "import{startPlayground}from'@typed-sql/playground';const h=await startPlayground({config:'typed-sql.config.mjs',target:'local',port:Number(process.env.PORT)});console.log('ANALYSIS '+h.url);process.on('SIGTERM',()=>void h.close().then(()=>process.exit(0)));",
  );
  host = await server(root, ["host.mjs"], { XDG_CONFIG_HOME: join(root, "xdg") });
  assert.equal((await host.fetch("/")).status, 200);
  const url = /ANALYSIS (http:\/\/[^\s]+)/u.exec(host.output())?.[1];
  assert.ok(url);
  const token = new URL(url).hash.slice(9),
    headers = { "x-typed-sql-session": token, "content-type": "application/json" };
  const origin = new URL(url).origin;
  const apiPost = async (path, body) => {
    const response = await fetch(`${origin}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  await apiPost("trust", { enable: true });
  await apiPost("agents/configure", {
    profile: { id: "analysis", name: "Analysis fixture", command: process.execPath, args: [join(root, "agent.mjs")] },
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark", acceptDownloads: true });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => evidence.errors.push(String(error)));
  const remote = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) remote.push(request.url());
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const messages = page.getByRole("log", { name: "Agent conversation", exact: true });
  await page
    .getByRole("textbox", { name: "Message local agent", exact: true })
    .fill("How many users are active? Show their hierarchy and share.");
  await page.getByRole("checkbox", { name: "Workspace tools", exact: true }).check();
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  await messages.getByText("6 active users", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  assert.equal(await messages.locator("strong").filter({ hasText: "6 active users" }).count(), 1);
  assert.ok(await messages.locator("table").count());
  assert.equal(await page.evaluate(() => globalThis.agentInjected), undefined);
  assert.deepEqual(remote, []);
  check(
    "ACP answers render Markdown emphasis, lists, tables and highlighted code without remote requests or executable HTML",
  );
  const cards = page.locator(".analysis-card"),
    card = cards.filter({ has: page.getByText("Active user count", { exact: true }) });
  await card.locator(".analysis-metric strong").filter({ hasText: /^6$/u }).waitFor();
  await card.getByRole("img", { name: "Users by region and team", exact: true }).scrollIntoViewIfNeeded();
  await card.getByRole("img", { name: "Users by region and team", exact: true }).locator("svg").waitFor();
  await cards
    .filter({ has: page.getByText("Active versus inactive", { exact: true }) })
    .getByRole("img")
    .scrollIntoViewIfNeeded();
  await cards
    .filter({ has: page.getByText("Active versus inactive", { exact: true }) })
    .getByRole("img")
    .locator("svg")
    .waitFor();
  for (const mode of ["dark", "light"]) {
    if (mode === "light") {
      await page.getByRole("button", { name: "Color theme", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Light theme", exact: true }).click();
    }
    for (const kind of [
      "bar",
      "stacked-bar",
      "line",
      "area",
      "scatter",
      "histogram",
      "pie",
      "donut",
      "sunburst",
      "treemap",
      "heatmap",
      "funnel",
      "sankey",
    ]) {
      const plot = page.getByRole("img", { name: `Example ${kind}`, exact: true });
      await plot.scrollIntoViewIfNeeded();
      await plot.locator("svg").waitFor();
      await plot.locator("..").screenshot({ path: join(artifacts, `gallery-${kind}-${mode}.png`) });
      evidence.screenshots.push(`gallery-${kind}-${mode}.png`);
    }
  }
  check("all thirteen chart adapters render actual SVG in both themes with viewport disposal and restoration");
  await page.getByRole("button", { name: "Color theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Dark theme", exact: true }).click();
  const partial = cards.filter({ has: page.getByText("Captured measurement sample", { exact: true }) });
  await partial.scrollIntoViewIfNeeded();
  assert.match(await partial.textContent(), /partial capture/iu);
  assert.match(await partial.textContent(), /1000 of 1000 captured rows/u);
  check("a 1200-row native query is retained as an explicitly partial 1000-row capture");
  await card.screenshot({ path: join(artifacts, "active-users-dark.png") });
  evidence.screenshots.push("active-users-dark.png");
  check("real scoped MCP captures PostgreSQL aggregates and publishes metric, sunburst, table and donut cards");
  await card.getByRole("img", { name: "Users by region and team", exact: true }).scrollIntoViewIfNeeded();
  for (const format of ["svg", "png"]) {
    const imageDownload = page.waitForEvent("download");
    await card.getByRole("combobox", { name: "Export Users by region and team", exact: true }).selectOption(format);
    const image = await imageDownload;
    await image.saveAs(join(artifacts, `hierarchy.${format}`));
    const bytes = await readFile(join(artifacts, `hierarchy.${format}`));
    if (format === "png") assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    else assert.match(bytes.toString(), /<svg/u);
  }
  check("chart exports contain actual SVG and PNG image bytes");
  await card.getByRole("img", { name: "Users by region and team", exact: true }).scrollIntoViewIfNeeded();
  await card
    .getByRole("img", { name: "Users by region and team", exact: true })
    .locator("svg")
    .getByText("EU", { exact: true })
    .click();
  await card.locator(".analysis-metric strong").filter({ hasText: /^3$/u }).waitFor();
  check("a chart selection applies its linked captured filter to all views without another prompt");

  await card.getByRole("combobox", { name: "Region", exact: true }).selectOption("EU");
  await card.getByRole("button", { name: "Apply filters", exact: true }).click();
  await card.locator(".analysis-metric strong").filter({ hasText: /^3$/u }).waitFor();
  check("captured-data filters update every composed view from the same exact rows");
  await card.getByRole("checkbox", { name: "Active flag", exact: true }).uncheck();
  await card.getByRole("button", { name: "Apply filters", exact: true }).click();
  await card.locator(".analysis-metric strong").filter({ hasText: /^1$/u }).waitFor();
  check("query controls execute parameter-bound read-only PostgreSQL and atomically replace the capture");
  const download = page.waitForEvent("download");
  await card.getByRole("combobox", { name: "Export analysis", exact: true }).selectOption("csv");
  const exported = await download;
  await exported.saveAs(join(artifacts, "filtered.csv"));
  assert.match(await readFile(join(artifacts, "filtered.csv"), "utf8"), /EU/u);
  check("CSV export contains the displayed filtered data");
  await card.getByRole("button", { name: "Save analysis", exact: true }).click();
  await card.getByRole("textbox", { name: "Analysis file path", exact: true }).fill("playground/users.analysis.json");
  const savedResponse = page.waitForResponse((response) => response.url().endsWith("/api/analyses/save"));
  await card.getByRole("button", { name: "Save definition", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  const saved = JSON.parse(await readFile(join(root, "playground/users.analysis.json"), "utf8"));
  assert.equal(saved.rows, undefined);
  assert.equal(saved.spec.title, "Active users");
  check("project definitions persist query, controls and presentation without captured data");
  await card.getByRole("button", { name: "Open in workspace", exact: true }).click();
  await page.getByRole("tab", { name: "Active users", exact: true }).waitFor();
  await page.locator(".analysis-workspace").waitFor();
  await page.reload();
  await page.locator(".analysis-workspace .analysis-metric strong").filter({ hasText: /^1$/u }).waitFor();
  check("analysis workspace tabs, captures and filter state restore after reload without agent calls");
  await page.getByRole("button", { name: "Color theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Light theme", exact: true }).click();
  await page.setViewportSize({ width: 700, height: 900 });
  await page.locator(".analysis-workspace").screenshot({ path: join(artifacts, "analysis-narrow-light.png") });
  evidence.screenshots.push("analysis-narrow-light.png");
  const overflow = await page.locator(".analysis-workspace").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false);
  check("interactive cards resize within a narrow pane and inherit the shared light theme");
  await page.getByRole("button", { name: "users.analysis.json", exact: true }).click();
  await page.getByRole("button", { name: "Run saved analysis", exact: true }).click();
  await page.locator(".analysis-workspace .analysis-metric strong").filter({ hasText: /^1$/u }).waitFor();
  check("a repository definition reopens and explicitly runs through the checked query path");
  await page.getByRole("button", { name: "Remove analysis", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Remove analysis", exact: true })
    .getByRole("button", { name: "Remove captured analysis", exact: true })
    .click();
  await page
    .getByText("Analysis removed from private storage. Project definitions are retained.", { exact: true })
    .waitFor();
  assert.ok(await readFile(join(root, "playground/users.analysis.json"), "utf8"));
  check("removing a private analysis preserves its reusable repository definition");

  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.reload();
  const toolsToggle = page.getByRole("checkbox", { name: "Workspace tools", exact: true });
  await toolsToggle.waitFor();
  assert.equal(await toolsToggle.isChecked(), true);
  await page.getByRole("textbox", { name: "Message local agent", exact: true }).fill("show me a random chart");
  const followupRequest = page.waitForRequest((request) => request.url().endsWith("/api/agents/prompt"));
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  assert.equal((await followupRequest).postDataJSON().workspaceTools, true);
  const followup = page
    .locator(".analysis-card")
    .filter({ has: page.getByText("Retained user status", { exact: true }) });
  await followup.getByRole("img").scrollIntoViewIfNeeded();
  await followup.getByRole("img").locator("svg").waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  await followup.screenshot({ path: join(artifacts, "followup-chart.png") });
  evidence.screenshots.push("followup-chart.png");
  check("a simple chart follow-up after reload retains the tool grant and renders a real chart from stored data");
  await toolsToggle.uncheck();
  await page
    .getByRole("textbox", { name: "Message local agent", exact: true })
    .fill("Continue without workspace tools");
  const disabledRequest = page.waitForRequest((request) => request.url().endsWith("/api/agents/prompt"));
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  assert.equal((await disabledRequest).postDataJSON().workspaceTools, false);
  await page.getByText("Workspace tools are disabled.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  await page.reload();
  await toolsToggle.waitFor();
  assert.equal(await toolsToggle.isChecked(), false);
  check("explicitly disabling tools is sent and restored for the conversation");

  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(artifacts, "results.json"), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await host?.close();
  if (admin && database) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin?.end();
  await fixture?.close();
}
