import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { command, consumer, server } from "../build/src/consumer.mjs";
import { commerceNamespaces, writeCommerceMigrations } from "./fixtures/commerce.mjs";

const artifacts = resolve("artifacts/playground-ui/explorer-browser");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const evidence = { node: process.version, cases: [], errors: [], screenshots: [] };
let fixture, host, browser, page, admin;
const created = [];
const check = (name, extra = {}) => {
  evidence.cases.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
async function shot(locator, name, width = 700, height = 320) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box);
  await page.screenshot({
    path: join(artifacts, `${name}.png`),
    animations: "disabled",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(width, box.width),
      height: Math.min(height, box.height),
    },
  });
  evidence.screenshots.push(`${name}.png`);
}
try {
  evidence.sourceHead = (await command(process.cwd(), "git", ["rev-parse", "HEAD"])).output.trim();
  fixture = await consumer(
    ["playwright", "typescript", "@types/node", "pg", "pg-cursor"],
    ["@typed-sql/playground", "@typed-sql/postgres", "@typed-sql/migrations"],
  );
  const require = createRequire(join(fixture.directory, "package.json"));
  const { Pool } = require("pg");
  const adminUrl = process.env.TYPED_SQL_EXPLORER_ADMIN_URL;
  if (!adminUrl)
    throw new Error("Set TYPED_SQL_EXPLORER_ADMIN_URL to an admin connection that may create isolated test databases.");
  admin = new Pool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const database = `typed_sql_explorer_${suffix}`,
    replayDatabase = `typed_sql_explorer_replay_${suffix}`;
  const connection = (name) => {
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return url.href;
  };
  for (const name of [database, replayDatabase]) {
    await admin.query(`create database "${name}"`);
    created.push(name);
    const pool = new Pool({ connectionString: connection(name) });
    try {
      for (const namespace of commerceNamespaces.filter((name) => name !== "public"))
        await pool.query(`create schema "${namespace}"`);
    } finally {
      await pool.end();
    }
  }
  await mkdir(join(fixture.directory, ".git"));
  const root = await fixture.project("commerce-explorer");
  await mkdir(join(root, "playground"));
  await writeFile(join(root, "playground/query.sql"), "select id, display_name from public.accounts;\n");
  for (let i = 0; i < 50; i++)
    await writeFile(join(root, `playground/query-${String(i).padStart(2, "0")}.sql`), "select 1;\n");
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: ["node"],
        allowArbitraryExtensions: true,
      },
      include: ["playground/**/*.ts"],
    }),
  );
  await writeFile(
    join(root, "explorer-targets.json"),
    JSON.stringify({
      schemas: commerceNamespaces,
      database,
      replayDatabase,
      databaseUrl: connection(database),
      replayUrl: connection(replayDatabase),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "typed-sql.config.mjs"),
    `
import {readFileSync} from 'node:fs';
import {defineConfig} from '@typed-sql/core';
import {defineMigrations} from '@typed-sql/migrations';
import {postgres,typePolicy} from '@typed-sql/postgres';
import {pg} from '@typed-sql/postgres/pg';
import {createPgMigrationTarget} from '@typed-sql/postgres/migrations';
import {createPgPlaygroundTarget} from '@typed-sql/playground/pg';
const fixture = JSON.parse(readFileSync(new URL('./explorer-targets.json', import.meta.url), 'utf8'));
const schemas = fixture.schemas;
const connectionString = () => fixture.databaseUrl;
export default defineConfig({
 dialect:postgres({typePolicy}),typePolicy,
 schema:{file:'schema.json',provider:pg({connectionString,typePolicy,schemas})},
 outDir:'generated',projects:['tsconfig.json'],
 playground:{readRoots:['playground','migrations'],writeRoots:['playground'],targets:{local:{classification:'development',expected:{database:fixture.database},connect:()=>createPgPlaygroundTarget({connectionString,typePolicy,schemas})}}},
 migrations:defineMigrations({directory:'migrations',replayTarget:'replay',targets:{
  local:createPgMigrationTarget({connectionString,namespaces:schemas,typePolicy,captureDetails:true,expected:{database:fixture.database},classification:'development'}),
  replay:createPgMigrationTarget({connectionString:()=>fixture.replayUrl,namespaces:schemas,typePolicy,captureDetails:true,expected:{database:fixture.replayDatabase},classification:'test',disposable:true})
 },policy:{drift:'block',unknownEvidence:'block',managedNamespaces:schemas}})
});
`,
  );
  await writeCommerceMigrations(join(root, "migrations"), { includePending: false });
  const setup = await fixture.node(
    root,
    `import{writeFile}from'node:fs/promises';import{createPlan,applyPlan}from'@typed-sql/migrations';import config from'./typed-sql.config.mjs';const options={root:process.cwd(),config:config.migrations,renderer:config.dialect,target:'local'};const plan=await createPlan(options);const result=await applyPlan({...options,plan});if(result.applied.length!==12)throw new Error('Expected 12 actual applications');await writeFile('schema.json',JSON.stringify(await config.schema.provider.introspect()));console.log('APPLIED',result.applied.length);`,
    "prepare.mjs",
  );
  assert.match(setup.output, /APPLIED 12/u);
  await writeCommerceMigrations(join(root, "migrations"));
  evidence.executedMigrations = 12;
  await writeFile(
    join(root, "host.mjs"),
    "import{startPlayground}from'@typed-sql/playground';const host=await startPlayground({config:'typed-sql.config.mjs',target:'local',port:Number(process.env.PORT)});console.log('EXPLORER_UI '+host.url);process.on('SIGTERM',()=>void host.close().then(()=>process.exit(0)));\n",
  );
  host = await server(root, ["host.mjs"], { XDG_CONFIG_HOME: join(root, "private-xdg") });
  assert.equal((await host.fetch("/")).status, 200);
  const url = /EXPLORER_UI (http:\/\/[^\s]+)/u.exec(host.output())?.[1];
  assert.ok(url);
  const { chromium } = require("playwright");
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
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => evidence.errors.push(String(error)));
  await page.goto(url);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true }),
    input = page.getByRole("combobox", { name: "Search files and commands", exact: true });
  async function invoke(query, label = query) {
    await page.keyboard.press("ControlOrMeta+k");
    await palette.waitFor();
    await input.fill(query);
    const option = palette.getByRole("option").filter({ has: page.getByText(label, { exact: true }) });
    await option.waitFor();
    await option.click();
    await palette.waitFor({ state: "detached" });
  }
  await page.getByRole("tree", { name: "Database objects" }).waitFor();
  const initialMigrations = page.getByRole("navigation", { name: "Project migrations", exact: true });
  await initialMigrations.locator(".migration-status.unverified").first().waitFor();
  assert.equal(await initialMigrations.locator(".migration-status.pending").count(), 0);
  check("unobserved migration definitions are explicitly unverified before connecting to persisted history");
  await invoke(">Connect to target", "Connect to target");
  const ready = page.waitForResponse((response) => response.url().endsWith("/api/explorer/refresh"));
  await page.getByRole("button", { name: "Refresh database and migration explorers", exact: true }).click();
  const explorerResponse = await ready;
  const explorer = await explorerResponse.json();
  assert.equal(explorerResponse.status(), 200, JSON.stringify(explorer));
  assert.equal(explorer.migrations.state, "ready");
  assert.equal(explorer.migrations.entries.filter((item) => item.status === "applied").length, 12);
  assert.equal(explorer.migrations.entries.filter((item) => item.status === "pending").length, 1);
  check(
    "packed host lists twelve actually executed migrations and one pending definition from a separate live database",
  );
  await page
    .getByRole("navigation", { name: "Project migrations", exact: true })
    .locator(".migration-status.applied")
    .first()
    .waitFor();
  const tree = page.getByRole("tree", { name: "Database objects" });
  const capturedNamespaces = explorer.schema.objects
    .filter((object) => object.kind === "namespace")
    .map((object) => object.name);
  for (const namespace of commerceNamespaces) assert.ok(capturedNamespaces.includes(namespace));
  await writeFile(join(artifacts, "explorer-response.json"), JSON.stringify(explorer, null, 2));
  await tree.getByRole("treeitem", { name: "public namespace", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const publicNamespace = tree.getByRole("treeitem", { name: "public namespace", exact: true });
  if ((await publicNamespace.getAttribute("aria-expanded")) === "false") await publicNamespace.press("ArrowRight");
  await publicNamespace.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const accounts = tree.getByRole("treeitem", { name: "accounts table", exact: true });
  await accounts.waitFor();
  await accounts.click();
  const objectDetails = page.getByRole("region", { name: "Database object details", exact: true });
  await objectDetails.getByRole("heading", { name: "accounts", exact: true }).waitFor();
  await accounts.press("ArrowRight");
  const columns = tree.getByRole("treeitem", { name: "Columns group", exact: true });
  await columns.waitFor();
  await columns.press("ArrowRight");
  await tree.getByRole("treeitem", { name: "contact_email column", exact: true }).click();
  await objectDetails.getByRole("heading", { name: "contact_email", exact: true }).waitFor();
  assert.match(await objectDetails.textContent(), /nullable/u);
  const email = tree.getByRole("treeitem", { name: "email column removed", exact: true });
  await email.click();
  await objectDetails.getByRole("heading", { name: "email", exact: true }).waitFor();
  check("namespace, table and column rows open captured definitions through keyboard-expandable hierarchy");
  await objectDetails.getByRole("tab", { name: /History/u }).click();
  await objectDetails.locator(".inspection-timeline").waitFor();
  assert.match(await objectDetails.textContent(), /004_account_profiles/u);
  await objectDetails.locator(".property-diff").first().waitFor();
  assert.match(await objectDetails.textContent(), /Not present/u);
  check("column history shows persisted structural additions and exact before/after properties");
  const enumObject = explorer.schema.objects.find(
    (object) => object.kind === "enum" && object.name === "payment_status",
  );
  assert.ok(enumObject);
  await invoke(
    `>Inspect ${enumObject.namespace}.${enumObject.name} (enum)`,
    `Inspect ${enumObject.namespace}.${enumObject.name} (enum)`,
  );
  await objectDetails.getByRole("heading", { name: "payment_status", exact: true }).waitFor();
  await objectDetails.getByRole("tab", { name: /History/u }).click();
  await objectDetails.locator(".property-diff").first().waitFor();
  assert.match(await objectDetails.textContent(), /refunded/u);
  check("enum evolution renders changed captured label values through command-palette navigation");
  const migrations = page.getByRole("navigation", { name: "Project migrations", exact: true });
  const pending = explorer.migrations.entries.find((item) => item.status === "pending");
  await migrations.getByRole("button", { name: new RegExp(pending.id, "u") }).click();
  const migrationDetails = page.getByRole("region", { name: "Migration details", exact: true });
  await migrationDetails.getByRole("heading", { name: pending.id, exact: true }).waitFor();
  await migrationDetails.getByRole("tab", { name: /History/u }).click();
  assert.match(await migrationDetails.textContent(), /No recorded execution attempts/u);
  check("pending migration details never claim an executed change");
  const removed = explorer.schema.objects.find(
    (object) => object.name === "payments_pending_idx" && object.details.exists === false,
  );
  assert.ok(removed);
  const removal = removed.history.find((event) => event.change === "removed");
  assert.ok(removal);
  await invoke(`>Inspect migration ${removal.migrationId}`, `Inspect migration ${removal.migrationId}`);
  await migrationDetails.getByRole("heading", { name: removal.migrationId, exact: true }).waitFor();
  await migrationDetails.getByRole("tab", { name: /History/u }).click();
  const removedChange = migrationDetails
    .locator(".migration-object-changes > details")
    .filter({ has: page.locator("summary", { hasText: "payments_pending_idx" }) });
  await removedChange.locator("summary").first().click();
  await removedChange.getByRole("button", { name: "Inspect payments_pending_idx", exact: true }).click();
  await objectDetails.getByRole("heading", { name: "payments_pending_idx", exact: true }).waitFor();
  assert.match(await objectDetails.textContent(), /absent from the current captured schema/u);
  check("migration changes link to removed indexes without substituting a current definition");
  for (const mode of ["light", "dark"]) {
    await invoke(`>Theme: ${mode[0].toUpperCase() + mode.slice(1)}`, `Theme: ${mode[0].toUpperCase() + mode.slice(1)}`);
    await shot(page.locator(".project-sidebar"), `sidebar-${mode}`, 238, 540);
    await shot(page.locator(".database-section"), `database-${mode}`, 238, 300);
    await shot(page.locator(".migrations-section"), `migrations-${mode}`, 238, 300);
    await objectDetails.getByRole("tab", { name: /History/u }).click();
    await shot(objectDetails, `removed-index-${mode}`, 700, 320);
    await shot(objectDetails.locator(".property-diff-scroll").first(), `removed-index-diff-${mode}`, 1040, 280);
  }
  const layout = await page.locator(".project-sidebar").evaluate((sidebar) => ({
    width: sidebar.clientWidth,
    sections: [...sidebar.querySelectorAll(".explorer-section")].map((section) => ({
      height: section.clientHeight,
      top: section.getBoundingClientRect().top,
      bottom: section.getBoundingClientRect().bottom,
    })),
    rows: [...sidebar.querySelectorAll(".explorer-row")].slice(0, 10).map((row) => ({
      row: row.getBoundingClientRect().width,
      parent: row.parentElement.getBoundingClientRect().width,
    })),
  }));
  assert.equal(layout.width, 238);
  assert.ok(layout.sections.every((section) => section.height >= 92));
  assert.ok(layout.rows.every((row) => Math.abs(row.row - row.parent) <= 1));
  check(
    "compact full-row selection and independent scroll sections remain consistent in light and dark themes",
    layout,
  );
  await invoke(">Focus migrations explorer", "Focus migrations explorer");
  await page.waitForFunction(
    () => document.activeElement?.closest("nav")?.getAttribute("aria-label") === "Project migrations",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest("nav")?.getAttribute("aria-label")),
    "Project migrations",
  );
  await invoke(">Focus database explorer", "Focus database explorer");
  await page.waitForFunction(
    () => document.activeElement?.closest('[role="tree"]')?.getAttribute("aria-label") === "Database objects",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest('[role="tree"]')?.getAttribute("aria-label")),
    "Database objects",
  );
  check("command palette focuses both explorers with keyboard-operable targets");
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".editor-pane").length === 2);
  const beforeResize = await page.locator(".editor-pane").first().boundingBox();
  await page.getByRole("separator", { name: "Resize editor split", exact: true }).press("ArrowRight");
  const afterResize = await page.locator(".editor-pane").first().boundingBox();
  assert.ok(afterResize.width > beforeResize.width);
  await page.setViewportSize({ width: 920, height: 900 });
  await page.waitForFunction(() => document.querySelectorAll(".editor-pane")[1]?.getBoundingClientRect().width <= 360);
  const narrow = await page.locator(".editor-pane").last().boundingBox();
  assert.ok(narrow.width >= 280 && narrow.width <= 360);
  await shot(page.locator(".editor-pane").last(), "narrow-inspection", 360, 320);
  const reboundExplorer = page.waitForResponse(
    (response) => response.url().endsWith("/api/explorer") && response.request().method() === "GET",
  );
  await page.reload();
  const rebound = await (await reboundExplorer).json();
  assert.equal(rebound.migrations.state, "ready");
  assert.ok(rebound.schema.objects.some((object) => object.id === removed.id));
  await page.waitForFunction(() => document.querySelectorAll(".editor-pane").length === 2);
  assert.equal(await page.getByRole("tab", { name: "payments_pending_idx", exact: true }).count(), 2);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".inspection-title h2")].filter(
        (node) => node.textContent === "payments_pending_idx",
      ).length === 2,
  );
  assert.equal(await page.getByRole("heading", { name: "payments_pending_idx", exact: true }).count(), 2);
  check("inspection tabs split, resize and restore without being treated as query files");
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
  if (admin) {
    for (const name of created.toReversed())
      await admin
        .query(`drop database "${name}" with (force)`)
        .catch((error) => console.error(`Cleanup ${name}: ${error.message}`));
    await admin.end();
  }
}
