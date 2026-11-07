import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { consumer } from "../build/src/consumer.mjs";

const artifacts = resolve("artifacts/playground-ui/interactions");
await mkdir(artifacts, { recursive: true });
const evidence = { cases: [], errors: [] };
let fixture, browser, server;
const check = (name) => {
  evidence.cases.push(name);
  console.log(`PASS ${name}`);
};
try {
  fixture = await consumer(["playwright"]);
  const { build } = createRequire(resolve("packages/playground/package.json"))("esbuild");
  const bundle = await build({
    stdin: {
      resolveDir: resolve("packages/playground"),
      sourcefile: "interactions-fixture.tsx",
      loader: "tsx",
      contents: `import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceFileTree} from './ui/file-tree';
import {PaneLayout,Resize} from './ui/panes';
window.events=[];
function App(){const [show,setShow]=useState(true);return <>
<button id="outside">Outside</button>
<section style={{width:300}}><WorkspaceFileTree files={['playground/q.ts']} folders={['playground']} selected="playground/q.ts" project="fixture" scratch="playground" onOpen={()=>{}} onCreate={async(path,folder)=>{window.events.push({path,folder})}}/></section>
<section style={{width:600,height:200}}><PaneLayout node={{kind:'pane',id:'pane',active:'playground/q.ts',tabs:['playground/q.ts'],bottom:'results',bottomRatio:.3}} active="pane" dirty={new Set()} onActivate={()=>{}} onOpen={()=>{}} onClose={()=>{}} onSplit={(_,direction)=>window.events.push({split:direction})} onDrop={()=>{}} onRatio={()=>{}} render={()=> <button>Pane content</button>}/></section>
<button id="toggle" onClick={()=>setShow(!show)}>Toggle resize</button>
<div style={{width:600,height:100}}>{show?<Resize axis="horizontal" value={37} label="Fixture resize" onChange={(delta)=>window.events.push({delta})}/>:null}</div>
</>};createRoot(document.getElementById('root')).render(<App/>);`,
    },
    bundle: true,
    write: false,
    outdir: join(fixture.directory, "interactions-assets"),
    format: "esm",
    jsx: "automatic",
  });
  server = createServer((request, response) => {
    if (request.url === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles.find((file) => file.path.endsWith(".js")).contents);
    } else if (request.url === "/fixture.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(bundle.outputFiles.find((file) => file.path.endsWith(".css")).contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html><head><title>Workspace interaction fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = createRequire(join(fixture.directory, "package.json"))("playwright");
  if (!process.env.TYPED_SQL_BROWSER_EXECUTABLE && process.env.TYPED_SQL_BROWSER_INSTALLED !== "1")
    await fixture.command(fixture.directory, "pnpm", ["exec", "playwright", "install", "chromium"]);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TYPED_SQL_BROWSER_EXECUTABLE ? { executablePath: process.env.TYPED_SQL_BROWSER_EXECUTABLE } : {}),
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => evidence.errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const file = page.getByRole("button", { name: "q.ts", exact: true });
  await file.focus();
  await page.keyboard.press("Shift+F10");
  const newFile = page.getByRole("menuitem", { name: "New File…", exact: true });
  await newFile.waitFor();
  assert.equal(await newFile.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await page
      .getByRole("menuitem", { name: "New Folder…", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Home");
  assert.equal(await newFile.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Escape");
  await newFile.waitFor({ state: "detached" });
  assert.equal(await file.evaluate((element) => element === document.activeElement), true);
  check("keyboard file menu focuses, wraps, navigates and restores its launcher on Escape");
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const folder = page.getByRole("textbox", { name: "New folder name", exact: true });
  await folder.waitFor();
  assert.equal(await folder.evaluate((element) => element === document.activeElement), true);
  await folder.fill("keyboard-folder");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    window.events.some((event) => event.path === "playground/keyboard-folder" && event.folder),
  );
  check("file menu Enter transfers focus to inline folder creation and submits it");
  const split = page.getByRole("button", { name: "Split editor", exact: true });
  await split.click();
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Split left", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.events.some((event) => event.split === "bottom"));
  await page.getByRole("menu", { name: "Split editor", exact: true }).waitFor({ state: "detached" });
  await split.click();
  await page.keyboard.press("Escape");
  assert.equal(await split.evaluate((element) => element === document.activeElement), true);
  await split.click();
  await page.locator("#outside").click();
  await page.getByRole("menu", { name: "Split editor", exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.locator("#outside").evaluate((element) => element === document.activeElement), true);
  check("split menu supports keyboard actions, Escape and outside dismissal without stealing focus");
  const resize = page.getByRole("separator", { name: "Fixture resize", exact: true });
  assert.equal(await resize.getAttribute("aria-valuenow"), "37");
  for (const stop of ["pointercancel", "blur", "pointerup"]) {
    const result = await page.evaluate((stop) => {
      const separator = document.querySelector('[aria-label="Fixture resize"]');
      const before = window.events.length;
      separator.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 }));
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 20 }));
      window.dispatchEvent(stop === "blur" ? new Event("blur") : new PointerEvent(stop, { pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 30 }));
      return { events: window.events.slice(before), resizing: document.body.classList.contains("is-resizing") };
    }, stop);
    assert.deepEqual(result, { events: [{ delta: 10 }], resizing: false });
  }
  check("resize stops on pointer cancellation, window blur and normal release");
  await resize.evaluate((element) =>
    element.addEventListener("gotpointercapture", () => {
      window.captured = true;
    }),
  );
  await resize.scrollIntoViewIfNeeded();
  const box = await resize.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
  assert.equal(await page.evaluate(() => window.captured), true);
  await page.mouse.move(1100, 650);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-resizing")), false);
  check("native pointer capture releases a drag outside its handle");
  await resize.dispatchEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 });
  // Remove the component without a pointerup; a native click would end the drag first.
  await page.locator("#toggle").evaluate((element) => element.click());
  await resize.waitFor({ state: "detached" });
  const result = await page.evaluate(() => {
    const before = window.events.length;
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 30 }));
    return { changed: window.events.length !== before, resizing: document.body.classList.contains("is-resizing") };
  });
  assert.deepEqual(result, { changed: false, resizing: false });
  check("unmounting an active resize removes its global listeners and selection suppression");
  assert.deepEqual(evidence.errors, []);
} finally {
  await writeFile(join(artifacts, "results.json"), JSON.stringify(evidence, null, 2));
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fixture?.close();
}
