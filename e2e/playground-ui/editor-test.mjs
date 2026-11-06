import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { command, consumer, server } from "../build/src/consumer.mjs";

const artifacts = resolve("artifacts/playground-ui/editor-browser");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const evidence = { node: process.version, cases: [], errors: [], screenshots: [] };
let fixture, host, browser, page;
const check = (name, extra = {}) => {
  evidence.cases.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
async function shot(locator, name) {
  const box = await locator.boundingBox();
  assert.ok(box);
  await page.screenshot({
    path: join(artifacts, `${name}.png`),
    animations: "disabled",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, 700),
      height: Math.min(box.height, 240),
    },
  });
  evidence.screenshots.push(`${name}.png`);
}
async function point(line, word) {
  return page
    .locator(".cm-line")
    .nth(line)
    .evaluate((element, value) => {
      const index = element.textContent.indexOf(value);
      if (index < 0) throw Error(`Missing token ${value} in ${element.textContent}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let offset = 0;
      while (node) {
        const size = node.textContent.length;
        if (index >= offset && index < offset + size) {
          const range = document.createRange();
          range.setStart(node, index - offset);
          range.setEnd(node, Math.min(node.textContent.length, index - offset + value.length));
          const box = range.getBoundingClientRect();
          return { x: box.left + Math.max(1, box.width / 2), y: box.top + box.height / 2 };
        }
        offset += size;
        node = walker.nextNode();
      }
      throw Error("Token has no rendered text range");
    }, word);
}
try {
  evidence.sourceHead = (await command(process.cwd(), "git", ["rev-parse", "HEAD"])).output.trim();
  fixture = await consumer(
    ["playwright", "typescript", "@types/node"],
    ["@typed-sql/playground", "@typed-sql/postgres", "@typed-sql/language-server"],
  );
  await mkdir(join(fixture.directory, ".git"));
  const root = await fixture.project("semantic-editor");
  await mkdir(join(root, "playground"));
  await writeFile(
    join(root, "schema.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        dialect: "postgres",
        tables: {
          "public.accounts": {
            name: "accounts",
            schema: "public",
            columns: {
              id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
              name: { name: "name", databaseType: "text", tsType: "string", nullable: true },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "typed-sql.config.mjs"),
    "import {postgres} from '@typed-sql/postgres';export default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],playground:{readRoots:['playground'],writeRoots:['playground']}};\n",
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        types: ["node"],
        allowJs: true,
        checkJs: true,
        allowArbitraryExtensions: true,
      },
      include: ["playground/**/*"],
    }),
  );
  const ts =
    "import { user } from './helper.js';\nconst profile = { name: 'Ada', age: 42 };\nprofile.name;\nconsole.log(user.name);\n";
  const sql = "select id, name from public.accounts;\n";
  await writeFile(join(root, "playground/query.ts"), ts);
  const js = `// @ts-check
${ts}`;
  await writeFile(join(root, "playground/javascript.js"), js);
  await writeFile(
    join(root, "playground/invalid-javascript.js"),
    "// @ts-check\n/** @type {number} */\nexport const age = 'wrong';\n",
  );
  await writeFile(join(root, "playground/helper.ts"), "export const user = { name: 'Ada' };\n");
  await writeFile(join(root, "playground/query.sql"), sql);
  await writeFile(join(root, "playground/fix.sql"), "select nam from public.accounts;\n");
  await writeFile(join(root, "playground/bad.ts"), "export const age: number = 'wrong';\n");
  await writeFile(join(root, "playground/bad.sql"), "select '😀' as emoji,\r\n  missing from public.accounts;\n");
  await writeFile(
    join(root, "playground/inline.ts"),
    "import { sql } from '@typed-sql/postgres';\nexport const query = sql`select id, name from public.accounts`;\n",
  );
  await writeFile(
    join(root, "host.mjs"),
    "import{startPlayground}from'@typed-sql/playground';const host=await startPlayground({config:'typed-sql.config.mjs',port:Number(process.env.PORT)});console.log('EDITOR_UI '+host.url);process.on('SIGTERM',()=>void host.close().then(()=>process.exit(0)));\n",
  );
  host = await server(root, ["host.mjs"], { XDG_CONFIG_HOME: join(root, "private-xdg") });
  assert.equal((await host.fetch("/")).status, 200);
  const url = /EDITOR_UI (http:\/\/[^\s]+)/u.exec(host.output())?.[1];
  assert.ok(url);
  const require = createRequire(join(fixture.directory, "package.json"));
  const { chromium } = require("playwright");
  evidence.playwright = require("playwright/package.json").version;
  evidence.companion = JSON.parse(
    await readFile(join(fixture.directory, "node_modules/@typed-sql/language-server/package.json"), "utf8"),
  ).version;
  if (!process.env.TYPED_SQL_BROWSER_EXECUTABLE && process.env.TYPED_SQL_BROWSER_INSTALLED !== "1")
    await fixture.command(root, "pnpm", ["exec", "playwright", "install", "chromium"], { timeout: 300000 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TYPED_SQL_BROWSER_EXECUTABLE ? { executablePath: process.env.TYPED_SQL_BROWSER_EXECUTABLE } : {}),
  });
  evidence.browser = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  page.on("pageerror", (error) => evidence.errors.push(String(error)));
  page.setDefaultTimeout(40000);
  await page.goto(url);
  await page.getByRole("navigation", { name: "Project files" }).waitFor();
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const input = page.getByRole("combobox", { name: "Search files and commands", exact: true });
  async function invoke(query, label = query) {
    await page.keyboard.press("ControlOrMeta+k");
    await palette.waitFor();
    await input.fill(query);
    const option = palette.getByRole("option").filter({ has: page.getByText(label, { exact: true }) });
    await option.waitFor();
    assert.equal(await option.getAttribute("aria-selected"), "true");
    await input.press("Enter");
    await palette.waitFor({ state: "detached" });
  }
  await invoke(">Enable trusted project execution", "Enable trusted project execution");
  const trust = page.getByRole("dialog", { name: "Enable project execution", exact: true });
  await trust.getByRole("button", { name: "Enable for this session", exact: true }).click();
  await trust.waitFor({ state: "detached" });
  await invoke("playground/query.ts");
  const editor = page.getByRole("textbox", { name: "Query source editor" });
  await editor.waitFor();
  const hoverPoint = await point(2, "name");
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  const hover = page.locator(".cm-tooltip-hover");
  await hover.waitFor();
  assert.match(await hover.textContent(), /string/u);
  await shot(hover, "typescript-hover");
  check("real pinned native TypeScript hover renders inferred property information");
  await page.mouse.move(2, 2);
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText("const profile = { name: 'Ada', age: 42 };\nprofile.");
  await page.keyboard.press("Control+Space");
  const suggestions = page.locator(".cm-tooltip-autocomplete");
  await suggestions.waitFor();
  await suggestions.getByText("name", { exact: true }).waitFor();
  for (const mode of ["light", "dark"]) {
    await page.getByRole("button", { name: "Color theme", exact: true }).click();
    await page
      .getByRole("menuitemradio", { name: `${mode[0].toUpperCase() + mode.slice(1)} theme`, exact: true })
      .click();
    await editor.focus();
    await page.keyboard.press("Control+Space");
    await suggestions.getByText("name", { exact: true }).waitFor();
    const colors = await suggestions.getByText("name", { exact: true }).evaluate((element) => {
      const row = element.closest("li");
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--selected)";
      document.body.append(probe);
      const expectedSelected = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "var(--panel)";
      const expectedPanel = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const painted = (node) => {
        for (let current = node; current; current = current.parentElement) {
          const color = getComputedStyle(current).backgroundColor;
          if (!color.endsWith(", 0)") && color !== "transparent") return color;
        }
        return "rgb(255, 255, 255)";
      };
      return {
        selected: painted(row),
        panel: painted(row.parentElement),
        expectedSelected,
        expectedPanel,
      };
    });
    assert.equal(colors.selected, colors.expectedSelected, `${mode} selected completion uses the workspace theme`);
    assert.equal(colors.panel, colors.expectedPanel, `${mode} completion list uses the workspace panel background`);
    await shot(suggestions, `typescript-completion-${mode}`);
  }
  check("completion menus retain workspace colors in light and dark themes");
  await suggestions.getByText("name", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("profile.name"));
  check("Ctrl+Space requests actual native completions and applies the resolved edit");
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText("us");
  await page.keyboard.press("Control+Space");
  await suggestions.waitFor();
  await suggestions.getByText("user", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("import"));
  await editor.pressSequentially(".name");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("user.name"));
  assert.ok(
    !(await editor.textContent()).includes("imp.nameort"),
    "Auto-import edits must leave the caret after the inserted expression",
  );
  check("native auto-import completion applies additional edits and preserves the expression caret");
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(ts);
  const definitionPoint = await point(3, "user");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.mouse.click(definitionPoint.x, definitionPoint.y);
  await page.keyboard.up(modifier);
  await page.locator('.document-path[title="playground/helper.ts"]').waitFor();
  assert.match(await editor.textContent(), /export const user/u);
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "user");
  check("Cmd/Ctrl-click opens the real imported TypeScript definition and selects its source range");
  await invoke("playground/query.ts");
  const importPoint = await point(0, "./helper.js");
  await page.keyboard.down(modifier);
  await page.mouse.click(importPoint.x, importPoint.y);
  await page.keyboard.up(modifier);
  await page.locator('.document-path[title="playground/helper.ts"]').waitFor();
  await invoke("playground/query.ts");
  await editor.press("ControlOrMeta+Home");
  for (let i = 0; i < ts.indexOf("./helper.js") + 3; i++) await editor.press("ArrowRight");
  await page.keyboard.press("F12");
  await page.locator('.document-path[title="playground/helper.ts"]').waitFor();
  check("Cmd-click and F12 on a .js import specifier use native NodeNext resolution to its .ts source");
  await invoke("playground/query.ts");
  await editor.press("ControlOrMeta+Home");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("ArrowRight");
  await page.keyboard.press("F12");
  await page.waitForFunction(() => window.getSelection()?.toString() === "profile");
  check("F12 navigates to the real local TypeScript definition");
  const menuPoint = await point(2, "name");
  await page.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Editor actions", exact: true });
  await menu.waitFor();
  for (const label of [
    "Go to definition",
    "Show type information",
    "Trigger suggestions",
    "Quick fixes…",
    "Find in file",
    "Select all",
    "Copy selection",
  ])
    await menu.getByRole("menuitem", { name: new RegExp(`^${label}`, "u") }).waitFor();
  await shot(menu, "editor-context-menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await page.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Show type information", exact: true }).click();
  await hover.waitFor();
  assert.match(await hover.textContent(), /string/u);
  await editor.press("Escape");
  await hover.waitFor({ state: "detached" });
  await page.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });
  await menu.waitFor();
  await page.mouse.click(2, 2);
  await menu.waitFor({ state: "detached" });
  check("editor context actions are keyboard reachable and close on Escape/outside click");
  await invoke("playground/query.sql");
  const sqlHoverPoint = await point(0, "id");
  await page.mouse.move(sqlHoverPoint.x, sqlHoverPoint.y);
  await hover.waitFor();
  assert.match(await hover.textContent(), /number/u);
  await shot(hover, "sql-hover");
  check("standalone SQL hover uses typed-sql schema inference");
  await page.mouse.move(2, 2);
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText("select a. from public.accounts a;");
  await editor.press("Home");
  for (let i = 0; i < 9; i++) await editor.press("ArrowRight");
  await page.keyboard.press("Meta+Space");
  await suggestions.waitFor();
  await suggestions.getByText("name", { exact: true }).waitFor();
  await shot(suggestions, "sql-completion");
  await suggestions.getByText("name", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("a.name"));
  check("Cmd+Space requests real SQL alias/column completions and applies them without querying a database");
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText("select  from public.accounts;");
  await editor.press("Home");
  for (let i = 0; i < 7; i++) await editor.press("ArrowRight");
  await editor.pressSequentially("na");
  await suggestions.waitFor();
  await suggestions.getByText("name", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("select name from"));
  check("typing in SQL triggers schema-aware completion without an explicit shortcut");
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(sql);
  const tablePoint = await point(0, "accounts");
  await page.keyboard.down(modifier);
  await page.mouse.click(tablePoint.x, tablePoint.y);
  await page.keyboard.up(modifier);
  await page.getByText("Read-only definition", { exact: true }).waitFor();
  assert.equal(await editor.getAttribute("contenteditable"), "false");
  assert.match(await editor.textContent(), /public.accounts/u);
  const readOnlyText = await editor.textContent();
  await page.keyboard.type("must-not-edit");
  assert.equal(await editor.textContent(), readOnlyText);
  await shot(page.locator(".document-editor"), "schema-definition-readonly");
  check("SQL definitions open captured schema evidence as a selected read-only source view");
  await invoke("playground/bad.ts");
  await page.locator(".cm-lintRange-error").first().waitFor();
  await page.getByRole("tab", { name: /^Problems(?:\s+\d+)?$/u }).click();
  await page
    .locator(".problems-list")
    .getByText(/number/u)
    .first()
    .waitFor();
  await shot(page.locator(".document-editor"), "typescript-inline-error");
  check("native TypeScript errors appear inline and in Problems before Run");
  await invoke("playground/bad.sql");
  await page.locator(".cm-lintRange-error").first().waitFor();
  assert.match(await page.locator(".cm-lintRange-error").first().textContent(), /missing/u);
  await page.getByRole("tab", { name: /^Problems(?:\s+\d+)?$/u }).click();
  await page
    .locator(".problems-list")
    .getByText(/TSQ101/u)
    .first()
    .waitFor();
  await shot(page.locator(".document-editor"), "sql-inline-error-unicode");
  check("SQL diagnostics retain original UTF-16 token ranges after Unicode and normalized CRLF");
  await invoke("playground/fix.sql");
  await page.locator(".cm-lintRange-error").first().waitFor();
  await editor.press("Home");
  for (let i = 0; i < 8; i++) await editor.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+.");
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Replace with name", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("select name from"));
  assert.equal(await readFile(join(root, "playground/fix.sql"), "utf8"), "select nam from public.accounts;\n");
  check("typed-sql quick fixes apply exact current-document edits without saving the file");
  await invoke("playground/inline.ts");
  const inlineHover = await point(1, "id");
  await page.mouse.move(inlineHover.x, inlineHover.y);
  await hover.waitFor();
  assert.match(await hover.textContent(), /number/u);
  await shot(hover, "embedded-sql-hover");
  check("SQL inside TypeScript uses the existing typed-sql language service");
  await page.mouse.move(2, 2);
  await invoke("playground/javascript.js");
  await page.locator('.file-tree button[title="playground/javascript.js"] .icon-file-js').waitFor();
  await page.locator('.pane-tab button[title="playground/javascript.js"] .icon-file-js').waitFor();
  const jsHoverPoint = await point(3, "name");
  await page.mouse.move(jsHoverPoint.x, jsHoverPoint.y);
  await hover.waitFor();
  assert.match(await hover.textContent(), /string/u);
  await shot(hover, "javascript-hover");
  check("JavaScript files show JS icons and actual native property hover");
  await page.mouse.move(2, 2);
  const jsImportPoint = await point(1, "./helper.js");
  await page.keyboard.down(modifier);
  await page.mouse.click(jsImportPoint.x, jsImportPoint.y);
  await page.keyboard.up(modifier);
  await page.locator('.document-path[title="playground/helper.ts"]').waitFor();
  check("JavaScript import-specifier navigation resolves .js to TypeScript through NodeNext");
  await invoke("playground/javascript.js");
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText("// @ts-check\nconst profile = { name: 'Ada' };\nprofile.");
  await page.keyboard.press("Control+Space");
  await suggestions.getByText("name", { exact: true }).waitFor();
  await suggestions.getByText("name", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("profile.name"));
  check("JavaScript completion uses the native JavaScript document language and applies property edits");
  await invoke("playground/invalid-javascript.js");
  await page.locator(".cm-lintRange-error").first().waitFor();
  await page.getByRole("tab", { name: /^Problems(?:\s+\d+)?$/u }).click();
  await page
    .locator(".problems-list")
    .getByText(/number/u)
    .first()
    .waitFor();
  await shot(page.locator(".document-editor"), "javascript-inline-error");
  check("checkJs/JSDoc JavaScript errors appear inline and in Problems before Run");
  assert.deepEqual(evidence.errors, [], "Browser has no runtime exceptions");
  assert.equal(
    await readFile(join(root, "playground/query.sql"), "utf8"),
    sql,
    "Editor intelligence never silently saves files",
  );
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
