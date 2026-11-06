import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { command, consumer, server } from "../build/src/consumer.mjs";

const artifacts = resolve("artifacts/playground-ui/browser");
await mkdir(artifacts, { recursive: true });
const evidence = { node: process.version, cases: [], errors: [], screenshots: [] };
let fixture, host, browser, page;
const check = (name, details = {}) => {
  evidence.cases.push({ name, ...details });
  console.log(`PASS ${name}`);
};
async function screenshot(locator, name) {
  const path = join(artifacts, `${name}.png`);
  const box = await locator.boundingBox();
  assert.ok(box, "Screenshot target must be visible");
  await page.screenshot({
    path,
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
async function bounded(locator, viewport) {
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "Control must have visible geometry");
  assert.ok(
    box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `Control is clipped: ${JSON.stringify(box)}`,
  );
  assert.ok(
    await locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === element || element.contains(hit);
    }),
    "Control must be reachable by pointer, not only present in the DOM",
  );
}
try {
  evidence.sourceHead = (await command(process.cwd(), "git", ["rev-parse", "HEAD"])).output.trim();
  fixture = await consumer(
    ["playwright", "typescript", "@types/node"],
    ["@typed-sql/playground", "@typed-sql/postgres"],
  );
  const root = await fixture.project("workspace-ui");
  const source = `select id, name from public.accounts;\n${Array.from({ length: 160 }, (_, i) => `-- editor scroll fixture line ${i}: ${"long source ".repeat(12)}`).join("\n")}\n`;
  await mkdir(join(root, "playground"), { recursive: true });
  await writeFile(
    join(root, "schema.json"),
    JSON.stringify({
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
    }),
  );
  await writeFile(
    join(root, "typed-sql.config.mjs"),
    "import {postgres} from '@typed-sql/postgres';export default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],playground:{readRoots:['playground'],writeRoots:['playground']}};\n",
  );
  await writeFile(join(root, "playground/selection.sql"), source);
  for (let i = 0; i < 8; i++)
    await writeFile(join(root, `playground/query-${i}-long-tab-name.sql`), "select id from public.accounts;\n");
  await writeFile(
    join(root, "workspace-host.mjs"),
    `import {startPlayground} from '@typed-sql/playground';const host=await startPlayground({config:'typed-sql.config.mjs',port:Number(process.env.PORT)});console.log('WORKSPACE_UI '+host.url);process.on('SIGTERM',()=>void host.close().then(()=>process.exit(0)));`,
  );
  host = await server(root, ["workspace-host.mjs"], { XDG_CONFIG_HOME: join(root, "private-xdg") });
  const response = await host.fetch("/");
  assert.equal(response.status, 200);
  const url = /WORKSPACE_UI (http:\/\/[^\s]+)/u.exec(host.output())?.[1];
  assert.ok(url, "Owned host must print its session URL");
  const require = createRequire(join(fixture.directory, "package.json"));
  const { chromium } = require("playwright");
  evidence.playwright = require("playwright/package.json").version;
  assert.equal(evidence.playwright, "1.64.1", "Browser fixture must use the CI-pinned Playwright release");
  if (!process.env.TYPED_SQL_BROWSER_EXECUTABLE && process.env.TYPED_SQL_BROWSER_INSTALLED !== "1")
    await fixture.command(root, "pnpm", ["exec", "playwright", "install", "chromium"], { timeout: 300000 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TYPED_SQL_BROWSER_EXECUTABLE ? { executablePath: process.env.TYPED_SQL_BROWSER_EXECUTABLE } : {}),
  });
  evidence.browser = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  page.on("pageerror", (error) => evidence.errors.push(String(error)));
  await page.goto(url);
  const tree = page.getByRole("navigation", { name: "Project files" });
  await tree.waitFor();
  const theme = page.getByRole("combobox", { name: "Color theme" });
  await theme.selectOption("system");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  check("system theme follows OS changes without a reload");

  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const folderName = page.getByRole("textbox", { name: "New folder name" });
  await folderName.fill("regression-empty");
  await folderName.press("Enter");
  await folderName.waitFor({ state: "detached" });
  assert.ok((await stat(join(root, "playground/regression-empty"))).isDirectory());
  assert.deepEqual(await readdir(join(root, "playground/regression-empty")), []);
  await page.getByRole("button", { name: "New file", exact: true }).click();
  const fileName = page.getByRole("textbox", { name: "New file name" });
  await fileName.fill("inline-created.sql");
  await fileName.press("Enter");
  await fileName.waitFor({ state: "detached" });
  assert.equal(await readFile(join(root, "playground/inline-created.sql"), "utf8"), "");
  // The unused lower part of the navigation region is deliberately exercised, not a file row.
  const treeBox = await tree.boundingBox();
  await tree.click({ button: "right", position: { x: Math.min(100, treeBox.width - 20), y: treeBox.height - 8 } });
  await page.getByRole("menuitem", { name: "New Folder…" }).click();
  await folderName.fill("blank-context-folder");
  await folderName.press("Enter");
  await folderName.waitFor({ state: "detached" });
  assert.deepEqual(await readdir(join(root, "playground/blank-context-folder")), []);
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await fileName.fill("cancelled.sql");
  await fileName.press("Escape");
  assert.equal(await fileName.count(), 0);
  check("inline file/folder creation and blank-space context menu persist real paths");

  const fileRow = tree.locator('[title="playground/selection.sql"]');
  const folderRow = tree.locator('[title="playground/regression-empty"]');
  const metrics = await Promise.all(
    [fileRow, folderRow].map((locator) =>
      locator.evaluate((element) => {
        const row = element.getBoundingClientRect(),
          label = element.querySelector(".tree-name");
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        return {
          height: row.height,
          width: row.width,
          labelX: text.left - row.left,
          textTop: text.top - row.top,
          textHeight: text.height,
        };
      }),
    ),
  );
  assert.ok(
    Math.abs(metrics[0].labelX - metrics[1].labelX) <= 1,
    "File/folder names at the same depth share an indent",
  );
  assert.ok(Math.abs(metrics[0].textTop - metrics[1].textTop) <= 1, "File/folder text shares a baseline");
  assert.ok(
    metrics.every((row) => row.height >= 24 && row.width >= treeBox.width - 2),
    "Rows have a full-width interactive wrapper",
  );
  await fileRow.hover();
  const hover = await fileRow.evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(hover, "rgba(0, 0, 0, 0)", "Hover fills the row wrapper");
  await screenshot(page.locator(".project-sidebar"), "file-tree");
  check("tree rows align names and expose full-width hover targets", { metrics });

  for (let i = 0; i < 8; i++) await tree.locator(`[title="playground/query-${i}-long-tab-name.sql"]`).click();
  await fileRow.click();
  const tabs = page.getByRole("tablist", { name: "Open workspace tabs" });
  const tabMetrics = await tabs.evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(tabMetrics.scrollWidth > tabMetrics.width, "Fixture must exercise horizontal tab overflow");
  assert.ok(tabMetrics.scrollHeight <= tabMetrics.height + 1, "Tabs must not create a vertical scrollbar");
  const tabScrollBefore = await tabs.evaluate((e) => e.scrollLeft);
  const tabBox = await tabs.boundingBox();
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  const tabDirection = await tabs.evaluate((e) => (e.scrollLeft < (e.scrollWidth - e.clientWidth) / 2 ? 350 : -350));
  await page.mouse.wheel(tabDirection, 0);
  await page.waitForFunction(
    (previous) => document.querySelector('[aria-label="Open workspace tabs"]').scrollLeft !== previous,
    tabScrollBefore,
  );
  const horizontalRail = page.getByRole("scrollbar", { name: "Content horizontal scroll" });
  await horizontalRail.waitFor();
  assert.equal(await horizontalRail.getAttribute("aria-controls"), await tabs.getAttribute("id"));
  assert.equal(
    await page.getByRole("scrollbar", { name: "Content vertical scroll" }).count(),
    0,
    "Horizontal-only tab overflow must not paint a vertical overlay",
  );
  await screenshot(page.locator(".pane-tabbar"), "tabs");
  check("overflowing tabs scroll horizontally without vertical scroll", tabMetrics);

  const editor = page.getByRole("textbox", { name: "Query source editor" });
  for (const mode of ["light", "dark"]) {
    await theme.selectOption(mode);
    await editor.click();
    await editor.press("ControlOrMeta+Home");
    for (let i = 0; i < 6; i++) await editor.press("Shift+ArrowRight");
    await page.waitForFunction(() => window.getSelection()?.toString() === "select");
    await page.waitForFunction(() => {
      const native = window.getSelection();
      if (!native?.rangeCount) return false;
      const expected = native.getRangeAt(0).getBoundingClientRect();
      return [...document.querySelectorAll(".cm-selectionBackground")].some(
        (e) => Math.abs(e.getBoundingClientRect().width - expected.width) < 1 && expected.width > 20,
      );
    });
    const selection = await page
      .locator(".cm-selectionBackground")
      .first()
      .evaluate((e) => ({
        color: getComputedStyle(e).backgroundColor,
        width: e.getBoundingClientRect().width,
        height: e.getBoundingClientRect().height,
      }));
    assert.ok(
      selection.width > 20 && selection.height >= 12,
      "A partial keyboard selection paints a visible rectangle",
    );
    assert.notEqual(selection.color, "rgba(0, 0, 0, 0)");
    const active = await page
      .locator(".cm-activeLine")
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    const values = active.match(/[\d.]+/gu)?.map(Number) ?? [];
    assert.ok(
      values.length === 4 && values[3] > 0 && values[3] <= 0.16,
      `Active line is a translucent accent rather than an opaque overlay: ${active}`,
    );
    await screenshot(page.locator(".document-editor"), `selection-focused-${mode}`);
    await theme.focus();
    await page.waitForFunction(() => !document.querySelector(".cm-editor.cm-focused"));
    const inactive = await page
      .locator(".cm-selectionBackground")
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.notEqual(inactive, "rgba(0, 0, 0, 0)", "Unfocused selection remains visible");
    assert.notEqual(inactive, selection.color, "Focused and unfocused selections have distinct contrast");
    check(`actual keyboard selection remains visible focused/unfocused in ${mode}`, { selection, inactive, active });
  }

  // Exercise a genuinely overflowing non-editor region, then compare its box before/after floating rails.
  for (let i = 0; i < 55; i++)
    await writeFile(
      join(root, `playground/scroll-fixture-${String(i).padStart(2, "0")}.sql`),
      "select id from public.accounts;\n",
    );
  await page.waitForFunction(() => {
    const n = document.querySelector('nav[aria-label="Project files"]');
    return n.scrollHeight > n.clientHeight;
  });
  const before = await tree.evaluate((e) => ({ offset: e.offsetWidth, client: e.clientWidth, top: e.scrollTop }));
  const box = await tree.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 380);
  await page.waitForFunction(() => document.querySelector('nav[aria-label="Project files"]').scrollTop > 0);
  const vertical = page.getByRole("scrollbar", { name: "Content vertical scroll" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="scrollbar"]')].some((e) => Number(getComputedStyle(e).opacity) > 0.1),
  );
  const after = await tree.evaluate((e) => ({
    offset: e.offsetWidth,
    client: e.clientWidth,
    top: e.scrollTop,
    id: e.id,
  }));
  assert.equal(await vertical.getAttribute("aria-controls"), after.id);
  assert.ok(after.top > before.top);
  assert.ok(after.offset - after.client <= 2, "Native scrollbars reserve no content width");
  assert.equal(after.client, before.client, "Floating overlay does not change the viewport width");
  await screenshot(page.locator(".global-scrollbars"), "floating-scroll-rail");
  const thumb = vertical.locator(".scroll-overlay-thumb");
  const thumbBox = await thumb.boundingBox();
  assert.ok(thumbBox && thumbBox.height > 0);
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2 + 32, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    (previous) => document.querySelector('nav[aria-label="Project files"]').scrollTop > previous,
    after.top,
  );
  check("floating scrollbar thumb drag advances native content", {
    before: after.top,
    after: await tree.evaluate((e) => e.scrollTop),
  });
  await page.mouse.move(600, 20);
  await theme.focus(); // A focused scrollbar stays visible for keyboard accessibility; test inactivity after leaving it.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="scrollbar"]')].every((e) => Number(getComputedStyle(e).opacity) < 0.05),
  );
  check("non-editor overlay follows native scroll without reserved space and auto-hides", { before, after });

  await editor.click();
  const scroller = page.locator(".cm-scroller");
  const editorBox = await scroller.boundingBox();
  await page.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2);
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector(".cm-scroller").scrollTop > 0);
  const editorScroll = await scroller.evaluate((e) => ({
    top: e.scrollTop,
    gutter: e.offsetWidth - e.clientWidth,
    native: getComputedStyle(e).scrollbarWidth,
    webkit: getComputedStyle(e, "::-webkit-scrollbar").display,
  }));
  assert.ok(editorScroll.gutter <= 2, "The editor reserves no scrollbar gutter");
  assert.ok(
    editorScroll.native === "none" || editorScroll.webkit === "none",
    "The editor visually hides native scrollbars while remaining scrollable",
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.global-scrollbars [role="scrollbar"]')].every(
      (e) => Number(getComputedStyle(e).opacity) < 0.05,
    ),
  );
  await screenshot(page.locator(".document-editor"), "editor-scrolling-no-visual-rail");
  check("editor scrolls with no native or global visual scrollbar", editorScroll);

  await page.setViewportSize({ width: 700, height: 800 });
  for (const control of [
    theme,
    page.getByRole("button", { name: "Schema", exact: true }),
    page.getByRole("button", { name: "Compare", exact: true }),
    page.getByRole("button", { name: "Agent", exact: true }),
    page.getByRole("button", { name: "Connect", exact: true }),
    page.getByRole("button", { name: "Toggle project tree", exact: true }),
  ])
    await bounded(control, { width: 700, height: 800 });
  const header = page.locator(".workspace-toolbar");
  assert.ok(
    await header.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    "700px header must not clip controls horizontally",
  );
  await screenshot(header, "narrow-header-700");
  check("700px toolbar controls remain visible and pointer-reachable");
  assert.deepEqual(evidence.errors, [], "The real browser must have no runtime exceptions");
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
