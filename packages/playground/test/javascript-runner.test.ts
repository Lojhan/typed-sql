import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { callableExports, RunManager } from "../src/runner.js";
import { fixture } from "./helpers/fixture.js";

const limits = { timeoutMs: 12000, maxRows: 10, maxResultBytes: 100000, maxConsoleBytes: 100000 };
async function execute(
  directory: string,
  file: string,
  source: string,
  options: { allowJs?: boolean; checkJs?: boolean; jsx?: string; jsxFactory?: string } = {},
) {
  const project = join(directory, "tsconfig.json"),
    config = JSON.parse(await readFile(project, "utf8"));
  Object.assign(config.compilerOptions, options);
  config.include = ["playground/**/*"];
  await writeFile(project, JSON.stringify(config));
  await writeFile(join(directory, file), source);
  const manager = new RunManager(
    await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
    new WorkspaceFiles(directory, ["playground"], ["playground"]),
    limits,
    "local",
    project,
  );
  manager.trusted = true;
  try {
    const run = manager.start({ requestId: "javascript-run", file, revision: contentHash(source), mode: "export" });
    const until = Date.now() + 20000;
    while (!run.finishedAt && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    return run;
  } finally {
    await manager.close();
  }
}
await describe("JavaScript workspace files and precise execution loaders", async () => {
  await it("lists, saves, reads and moves real JavaScript-family files with revision protection", async () =>
    fixture(async (directory) => {
      const files = new WorkspaceFiles(directory, ["playground"], ["playground"]);
      for (const extension of ["js", "jsx", "mjs", "cjs"]) {
        const file = `playground/query.${extension}`,
          saved = await files.save(file, "export const value = 1;", null);
        strict.equal((await files.read(file)).revision, saved.revision);
        strict.ok((await files.list()).includes(file));
        await strict.rejects(files.save(file, "external overwrite", "stale"), /changed on disk/u);
        const moved = await files.move(file, `playground/moved.${extension}`, saved.revision);
        strict.ok((await files.list()).includes(moved.file));
      }
    }));
  await it("discovers exports using actual JS/JSX/TS/TSX syntax without executing code", async () => {
    strict.deepEqual(await callableExports("throw Error('never execute'); export const run=()=>42;", "q.js"), ["run"]);
    strict.deepEqual(await callableExports("export const run=()=> <box/>;", "q.jsx"), ["run"]);
    strict.deepEqual(await callableExports("export const run=():number=>42;", "q.ts"), ["run"]);
    strict.deepEqual(await callableExports("export const run=():unknown=> <box/>;", "q.tsx"), ["run"]);
    await strict.rejects(callableExports("export const run=():number=>42;", "q.js"));
    await strict.rejects(callableExports("export const run=():number=>42;", "q.jsx"));
    await strict.rejects(callableExports("export const run=()=> <box/>;", "q.js"));
  });
  await it("does not enable allowJs or checkJs behind the application's configuration", async () =>
    fixture(async (directory) => {
      const source = '/** @type {number} */ const value="text"; export function run(){return value;}';
      const disallowed = await execute(directory, "playground/query.js", source);
      strict.equal(disallowed.status, "failed", JSON.stringify(disallowed));
      strict.equal(disallowed.error?.code, "TYPECHECK");
      const unchecked = await execute(directory, "playground/query.js", source, { allowJs: true, checkJs: false });
      strict.equal(unchecked.status, "succeeded", JSON.stringify(unchecked));
      strict.equal(unchecked.results[0]?.value, "text");
      const checked = await execute(directory, "playground/query.js", source, { allowJs: true, checkJs: true });
      strict.equal(checked.status, "failed", JSON.stringify(checked));
      strict.equal(checked.error?.code, "TYPECHECK");
      strict.match(checked.error?.message ?? "", /2322/u);
    }));
  await it("executes JS tagged SQL with the project's actual helper module and decoding", async () =>
    fixture(async (directory) => {
      await writeFile(
        join(directory, "playground/db.js"),
        "export {databaseForRun as db} from '@typed-sql/playground/runtime';",
      );
      const source =
        "import {sql} from '@typed-sql/postgres';import {db} from './db.js';export async function run(){return db().all(sql`select id from public.accounts where id=${42}`);}";
      const run = await execute(directory, "playground/query.js", source, { allowJs: true, checkJs: true });
      strict.equal(run.status, "succeeded", JSON.stringify(run));
      strict.match(JSON.stringify(run.results[0]?.value), /42/u);
      const invalid = await execute(directory, "playground/query.js", source.replace("${42}", '${"wrong"}'), {
        allowJs: true,
        checkJs: true,
      });
      strict.equal(invalid.status, "failed", JSON.stringify(invalid));
      strict.equal(invalid.error?.code, "TYPECHECK");
      strict.match(invalid.error?.message ?? "", /2345/u);
      strict.deepEqual(invalid.results, []);
      const moduleRun = await execute(directory, "playground/query.mjs", source, { allowJs: true, checkJs: true });
      strict.equal(moduleRun.status, "succeeded", JSON.stringify(moduleRun));
      strict.match(JSON.stringify(moduleRun.results[0]?.value), /42/u);
    }));
  await it("captures JSX modules with their real JSX grammar, including compiler-owned SQL metadata", async () =>
    fixture(async (directory) => {
      const source =
        "import {sql} from '@typed-sql/postgres';import {databaseForRun} from '@typed-sql/playground/runtime';function h(tag,props,...children){return {tag,children};}export async function run(){return {view:<box>ok</box>,rows:await databaseForRun().all(sql`select id from public.accounts where id=${42}`)}}";
      const run = await execute(directory, "playground/query.jsx", source, {
        allowJs: true,
        checkJs: false,
        jsx: "react",
        jsxFactory: "h",
      });
      strict.equal(run.status, "succeeded", JSON.stringify(run));
      strict.match(JSON.stringify(run.results[0]?.value), /box/u);
      strict.match(JSON.stringify(run.results[0]?.value), /42/u);
    }));
  await it("executes TSX source using the project's configured JSX factory", async () =>
    fixture(async (directory) => {
      const source =
        "declare global {namespace JSX {interface IntrinsicElements {box:{children?:unknown}}}} function h(tag:string,props:unknown,...children:unknown[]){return {tag,children};} export function run(){return <box>ok</box>;}";
      const run = await execute(directory, "playground/query.tsx", source, { jsx: "react", jsxFactory: "h" });
      strict.equal(run.status, "succeeded", JSON.stringify(run));
      strict.match(JSON.stringify(run.results[0]?.value), /box/u);
    }));
  await it("keeps CommonJS files editable while reporting the unsupported Run mode precisely", async () =>
    fixture(async (directory) => {
      const run = await execute(directory, "playground/query.cjs", "module.exports.run=()=>42;", {
        allowJs: true,
        checkJs: false,
      });
      strict.equal(run.status, "failed", JSON.stringify(run));
      strict.equal(run.error?.code, "RUN_MODE");
      strict.match(run.error?.message ?? "", /CommonJS.*ESM/u);
    }));
});
