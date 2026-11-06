import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { EditorLspClient } from "../src/editor-lsp.js";
import { EditorRoutes } from "../src/editor-service.js";
import { WorkspaceFiles } from "../src/files.js";

const fake = `import {writeFileSync} from 'node:fs';let schemaChanges=0;let languageId='';let buffer=Buffer.alloc(0);let text='';let uri='';const send=v=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...v}));process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b)};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){let i=buffer.indexOf('\\r\\n\\r\\n');if(i<0)return;let n=Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,i).toString())[1]);if(buffer.length<i+4+n)return;let v=JSON.parse(buffer.subarray(i+4,i+4+n));buffer=buffer.subarray(i+4+n);
if(v.method==='initialize')send({id:v.id,result:{serverInfo:{name:'fixture'},capabilities:{hoverProvider:true}}});
else if(v.method==='textDocument/didOpen'){text=v.params.textDocument.text;uri=v.params.textDocument.uri;languageId=v.params.textDocument.languageId}
else if(v.method==='textDocument/didChange')text=v.params.contentChanges[0].text;
else if(v.method==='textDocument/diagnostic')send({id:v.id,result:{kind:'full',items:[]}});
else if(v.method==='workspace/didChangeWatchedFiles')schemaChanges++;
else if(v.method==='textDocument/hover'){if(text==='schema-slow')writeFileSync(process.cwd()+'/hover-started','1');setTimeout(()=>{send({id:v.id,result:{contents:text,schemaChanges,languageId}});if(text==='crash')setTimeout(()=>process.exit(0),10)},text.includes('slow')?100:0);}
else if(v.method==='textDocument/definition')send({id:v.id,result:[{uri:process.env.EDITOR_TEST_DEFINITION,range:{start:{line:0,character:0},end:{line:0,character:2}}}]});
else if(v.method==='malformed')process.stdout.write('garbage'.repeat(2000));
else if(v.method==='overflow')process.stdout.write('Content-Length: 99999999\\r\\n\\r\\n');
else if(v.method==='stall'){};
}});`;
async function fixture(action: (routes: EditorRoutes, files: WorkspaceFiles, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "typed-sql-editor-"));
  await mkdir(join(root, "playground"));
  await writeFile(join(root, "server.mjs"), fake);
  await writeFile(join(root, "schema.json"), "{}");
  await writeFile(join(root, "playground/query.ts"), "const saved = 1;");
  const files = new WorkspaceFiles(root, ["playground"], ["playground"]);
  const routes = new EditorRoutes({
    files,
    configFile: join(root, "config.ts"),
    schemaFile: join(root, "schema.json"),
    companionFile: join(root, "server.mjs"),
    timeoutMs: 1000,
  });
  try {
    await action(routes, files, root);
  } finally {
    await routes.close();
    await rm(root, { recursive: true, force: true });
  }
}
await describe("optional local editor companion", async () => {
  await it("requires trust, overlays unsaved source, echoes exact identity, and never writes the file", async () =>
    fixture(async (routes, files) => {
      const file = await files.read("playground/query.ts");
      const request = { ...file, source: "const unsaved = 2;", method: "hover", position: { line: 0, character: 7 } };
      await strict.rejects(routes.handle(request, false), /Trust this project/u);
      const result = (await routes.handle(request, true)) as Record<string, unknown>;
      strict.equal((result.result as { contents: string }).contents, request.source);
      strict.match(String(result.uri), /playground\/query.ts$/u);
      strict.equal(result.revision, file.revision);
      strict.equal((await files.read(file.file)).source, file.source);
    }));
  await it("opens each JS/TS/SQL extension with its native LSP language identifier", async () =>
    fixture(async (routes, files, root) => {
      for (const [extension, languageId] of [
        ["js", "javascript"],
        ["mjs", "javascript"],
        ["cjs", "javascript"],
        ["jsx", "javascriptreact"],
        ["ts", "typescript"],
        ["mts", "typescript"],
        ["cts", "typescript"],
        ["tsx", "typescriptreact"],
        ["sql", "sql"],
      ]) {
        const file = `playground/language.${extension}`;
        await writeFile(join(root, file), "source");
        const result = (await routes.handle(
          { ...(await files.read(file)), method: "hover", position: { line: 0, character: 0 } },
          true,
        )) as { result: { languageId: string } };
        strict.equal(result.result.languageId, languageId);
      }
    }));
  await it("rejects stale overlay results and disk revision changes", async () =>
    fixture(async (routes, files) => {
      const file = await files.read("playground/query.ts");
      const slow = routes.handle(
        { ...file, source: "slow", method: "hover", position: { line: 0, character: 0 } },
        true,
      );
      const guarded = strict.rejects(slow, /Source changed/u);
      const fresh = routes.handle(
        { ...file, source: "fresh", method: "hover", position: { line: 0, character: 0 } },
        true,
      );
      await guarded;
      strict.equal(((await fresh) as { result: { contents: string } }).result.contents, "fresh");
      await files.save(file.file, "changed", file.revision);
      await strict.rejects(routes.handle({ ...file, method: "diagnostics" }, true), /Source changed/u);
    }));
  await it("rejects incomplete, duplicate, out-of-scope, stale, and oversized working-copy contexts", async () =>
    fixture(async (routes, files, root) => {
      const request = { ...(await files.read("playground/query.ts")), method: "diagnostics" };
      await writeFile(join(root, "playground/helper.ts"), "export const value = 1;");
      const helper = await files.read("playground/helper.ts");
      await strict.rejects(routes.handle({ ...request, workingCopies: {} }, true), /complete array/u);
      await strict.rejects(routes.handle({ ...request, workingCopies: [helper, helper] }, true), /unique other/u);
      await strict.rejects(
        routes.handle({ ...request, workingCopies: [helper, { ...helper, file: "playground/./helper.ts" }] }, true),
        /unique other/u,
      );
      await strict.rejects(
        routes.handle({ ...request, workingCopies: [{ ...helper, file: "../escape.ts" }] }, true),
        /project-relative/u,
      );
      await strict.rejects(
        routes.handle({ ...request, workingCopies: [{ ...helper, revision: "stale" }] }, true),
        /working copy changed/u,
      );
      await strict.rejects(
        routes.handle(
          {
            ...request,
            source: "x".repeat(512 * 1024),
            workingCopies: [{ ...helper, source: "x".repeat(512 * 1024) }],
          },
          true,
        ),
        /complete editor context exceeds 1 MiB/u,
      );
    }));
  await it("hashes schema bytes before and after work despite equal size and preserved mtime", async () =>
    fixture(async (routes, files, root) => {
      const request = {
        ...(await files.read("playground/query.ts")),
        method: "hover",
        position: { line: 0, character: 0 },
      };
      const before = (await routes.handle(request, true)) as { projectSnapshotHash: string };
      const schema = join(root, "schema.json");
      const original = await stat(schema);
      await writeFile(schema, "[]");
      await utimes(schema, original.atime, original.mtime);
      const after = (await routes.handle(request, true)) as {
        projectSnapshotHash: string;
        result: { schemaChanges: number };
      };
      strict.notEqual(after.projectSnapshotHash, before.projectSnapshotHash);
      strict.equal(after.result.schemaChanges, 1);
      const slow = routes.handle({ ...request, source: "schema-slow" }, true);
      const rejected = strict.rejects(slow, /Schema changed/u);
      const deadline = Date.now() + 3000;
      while (
        !(await stat(join(root, "hover-started")).then(
          () => true,
          () => false,
        ))
      ) {
        if (Date.now() > deadline) throw new Error("Companion did not begin hover");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await writeFile(schema, "{}");
      await utimes(schema, original.atime, original.mtime);
      await rejected;
    }));
  await it("reports companion death and restarts with fresh document overlays after cooldown", async () =>
    fixture(async (routes, files) => {
      const request = {
        ...(await files.read("playground/query.ts")),
        method: "hover",
        position: { line: 0, character: 0 },
      };
      await routes.handle({ ...request, source: "crash" }, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const failed = (await routes.handle(request, true)) as { status: { state: string } };
      strict.equal(failed.status.state, "failed");
      const cooling = (await routes.handle(request, true)) as { status: { state: string } };
      strict.equal(cooling.status.state, "failed");
      await new Promise((resolve) => setTimeout(resolve, 1050));
      const recovered = (await routes.handle({ ...request, source: "recovered overlay" }, true)) as {
        status: { state: string };
        result: { contents: string };
      };
      strict.equal(recovered.status.state, "ready");
      strict.equal(recovered.result.contents, "recovered overlay");
    }));
  await it("returns honest unavailable status without a project-local package", async () =>
    fixture(async (_routes, files, root) => {
      const routes = new EditorRoutes({
        files,
        configFile: join(root, "config.ts"),
        schemaFile: join(root, "schema.json"),
      });
      try {
        const result = (await routes.handle(
          { ...(await files.read("playground/query.ts")), method: "diagnostics" },
          true,
        )) as { status: { state: string } };
        strict.equal(result.status.state, "unavailable");
      } finally {
        await routes.close();
      }
    }));
  await it("discovers a newly installed local companion after the unavailable cooldown", async () =>
    fixture(async (_routes, files, root) => {
      const routes = new EditorRoutes({
        files,
        configFile: join(root, "config.ts"),
        schemaFile: join(root, "schema.json"),
      });
      const request = {
        ...(await files.read("playground/query.ts")),
        method: "hover",
        position: { line: 0, character: 0 },
      };
      try {
        const absent = (await routes.handle(request, true)) as { status: { state: string } };
        strict.equal(absent.status.state, "unavailable");
        const installed = join(root, "node_modules/@typed-sql/language-server");
        await mkdir(installed, { recursive: true });
        await writeFile(
          join(installed, "package.json"),
          JSON.stringify({ name: "@typed-sql/language-server", bin: { "typed-sql-language-server": "./server.mjs" } }),
        );
        await writeFile(join(installed, "server.mjs"), fake);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        const ready = (await routes.handle(request, true)) as { status: { state: string } };
        strict.equal(ready.status.state, "ready");
      } finally {
        await routes.close();
      }
    }));
  await it("only opens a tokenized authorized definition and keeps it read-only", async () =>
    fixture(async (routes, files, root) => {
      process.env.EDITOR_TEST_DEFINITION = pathToFileURL(join(root, "schema.json")).href;
      try {
        const result = (await routes.handle(
          { ...(await files.read("playground/query.ts")), method: "definition", position: { line: 0, character: 0 } },
          true,
        )) as { result: { token: string }[] };
        const read = (await routes.handle({ method: "readDefinition", token: result.result[0]?.token }, true)) as {
          source: string;
          readOnly: boolean;
        };
        strict.equal(read.source, "{}");
        strict.equal(read.readOnly, true);
        await writeFile(join(root, "schema.json"), "[]");
        await strict.rejects(
          routes.handle({ method: "readDefinition", token: result.result[0]?.token }, true),
          (error: unknown) => {
            return (
              error instanceof Error &&
              "status" in error &&
              error.status === 409 &&
              /fresh definition/u.test(error.message)
            );
          },
        );
        await strict.rejects(
          routes.handle({ method: "readDefinition", token: "not-authorized" }, true),
          /fresh definition/u,
        );
      } finally {
        delete process.env.EDITOR_TEST_DEFINITION;
      }
    }));
  await it("cancels pending requests when the local companion closes", async () =>
    fixture(async (_routes, _files, root) => {
      const client = new EditorLspClient(process.execPath, [join(root, "server.mjs")], root, 5000);
      const pending = strict.rejects(client.request("stall", {}), /closed/u);
      await client.close();
      await pending;
    }));
  await it("rejects filesystem URI reads without an issued definition token", async () =>
    fixture(async (routes, files, root) => {
      const outside = join(root, "private.ts");
      await writeFile(outside, "secret");
      process.env.EDITOR_TEST_DEFINITION = pathToFileURL(outside).href;
      try {
        const result = (await routes.handle(
          { ...(await files.read("playground/query.ts")), method: "definition", position: { line: 0, character: 0 } },
          true,
        )) as { result: unknown[] };
        strict.deepEqual(result.result, []);
      } finally {
        delete process.env.EDITOR_TEST_DEFINITION;
      }
    }));
  for (const method of ["malformed", "overflow", "stall"])
    await it(`bounds ${method} child responses and releases pending work`, async () =>
      fixture(async (_routes, _files, root) => {
        const client = new EditorLspClient(process.execPath, [join(root, "server.mjs")], root, 100);
        try {
          await strict.rejects(client.request(method, {}), /language server/iu);
        } finally {
          await client.close();
        }
      }));
});

await it("uses the real pinned companion for native TypeScript and original SQL coordinates", async () => {
  const { fileURLToPath } = await import("node:url");
  const { dirname, relative, resolve } = await import("node:path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const temporary = await mkdtemp(join(root, "test/fixtures/success/.editor-proof-"));
  const files = new WorkspaceFiles(root, ["test/fixtures/success"], [relative(root, temporary)]);
  const schemaPath = join(temporary, "snapshot.json");
  const schemaSource = await readFile(join(root, "test/fixtures/success/schema.json"), "utf8");
  await writeFile(schemaPath, schemaSource);
  const routes = new EditorRoutes({
    files,
    configFile: join(root, "e2e/postgres/typed-sql.config.ts"),
    projectFile: join(root, "test/fixtures/success/tsconfig.json"),
    schemaFile: schemaPath,
    companionFile: join(root, "packages/language-server/dist/packages/language-server/src/server.js"),
    timeoutMs: 30_000,
  });
  try {
    const ts = await files.read("test/fixtures/success/query.ts");
    const native = (await routes.handle(
      {
        ...ts,
        source: 'const value = { name: "Ada" };\nvalue.name;',
        method: "hover",
        position: { line: 1, character: 7 },
      },
      true,
    )) as { result: unknown; status: { state: string } };
    strict.equal(native.status.state, "ready", JSON.stringify(native));
    strict.match(JSON.stringify(native.result), /string/u);
    const completion = (await routes.handle(
      {
        ...ts,
        source: 'const value = { name: "Ada" };\nvalue.',
        method: "completion",
        position: { line: 1, character: 6 },
      },
      true,
    )) as { result: unknown };
    strict.match(JSON.stringify(completion.result), /name/u);
    const item = (completion.result as { items: { label: string }[] }).items.find((item) => item.label === "name");
    const resolved = (await routes.handle(
      { ...ts, source: 'const value = { name: "Ada" };\nvalue.', method: "completionResolve", item },
      true,
    )) as { result: unknown };
    strict.match(JSON.stringify(resolved.result), /name/u);
    const nativeDefinition = (await routes.handle(
      {
        ...ts,
        source: 'const value = { name: "Ada" };\nvalue.name;',
        method: "definition",
        position: { line: 1, character: 1 },
      },
      true,
    )) as { result: { token: string }[] };
    strict.ok(nativeDefinition.result[0]?.token);
    const sqlPath = join(temporary, "query.sql");
    await writeFile(sqlPath, "SELECT id, name FROM users");
    const sql = await files.read(relative(root, sqlPath));
    const hover = (await routes.handle({ ...sql, method: "hover", position: { line: 0, character: 8 } }, true)) as {
      result: unknown;
    };
    strict.match(JSON.stringify(hover.result), /number/u);
    const schemaCompletions = (await routes.handle(
      { ...sql, method: "completion", position: { line: 0, character: 7 } },
      true,
    )) as { result: { items: { label: string }[] } };
    const schemaItem = schemaCompletions.result.items.find((item) => item.label === "id");
    strict.ok(schemaItem);
    const schemaResolved = (await routes.handle({ ...sql, method: "completionResolve", item: schemaItem }, true)) as {
      result: unknown;
    };
    strict.deepEqual(schemaResolved.result, schemaItem);
    const definition = (await routes.handle(
      { ...sql, method: "definition", position: { line: 0, character: 23 } },
      true,
    )) as { result: { token: string }[] };
    strict.ok(definition.result[0]?.token);
    const schemaTime = await stat(schemaPath);
    await writeFile(schemaPath, schemaSource.replace('"name": { "name": "name"', '"nope": { "name": "nope"'));
    await utimes(schemaPath, schemaTime.atime, schemaTime.mtime);
    const refreshed = (await routes.handle({ ...sql, method: "diagnostics" }, true)) as {
      diagnostics: { code: string }[];
    };
    strict.ok(
      refreshed.diagnostics.some((item) => item.code === "TSQ101"),
      JSON.stringify(refreshed),
    );
    await writeFile(schemaPath, schemaSource);
    await utimes(schemaPath, schemaTime.atime, schemaTime.mtime);
    const source = "SELECT '😀' AS emoji,\r\n  missing FROM users";
    const invalid = (await routes.handle({ ...sql, source, method: "diagnostics" }, true)) as {
      diagnostics: { code: string; range: unknown }[];
    };
    const missing = invalid.diagnostics.find((item) => item.code === "TSQ101");
    strict.deepEqual(
      missing?.range,
      { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
      JSON.stringify(invalid),
    );
  } finally {
    await routes.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

await it("uses native JS checking configuration and TypeScript runtime-specifier resolution", async () => {
  const { fileURLToPath } = await import("node:url");
  const { dirname, relative, resolve } = await import("node:path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const temporary = await mkdtemp(join(root, ".editor-js-proof-"));
  const projectFile = join(temporary, "tsconfig.json");
  const files = new WorkspaceFiles(root, [relative(root, temporary)], [relative(root, temporary)]);
  const config = (checkJs: boolean) =>
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs,
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ESNext",
        jsx: "preserve",
      },
      include: ["./**/*"],
    });
  const createRoutes = () =>
    new EditorRoutes({
      files,
      configFile: join(root, "e2e/postgres/typed-sql.config.ts"),
      projectFile,
      schemaFile: join(root, "test/fixtures/success/schema.json"),
      companionFile: join(root, "packages/language-server/dist/packages/language-server/src/server.js"),
      timeoutMs: 30_000,
    });
  let routes: EditorRoutes | undefined;
  try {
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(projectFile, config(false));
    for (const extension of ["ts", "mts", "cts"])
      await writeFile(join(temporary, `helper.${extension}`), 'export const typed = { label: "typed" };');
    const jsSource = 'import { typed } from "./helper.js";\n/** @type {number} */\nconst age = "wrong";\ntyped.label;';
    await writeFile(join(temporary, "query.js"), jsSource);
    routes = createRoutes();
    const js = await files.read(relative(root, join(temporary, "query.js")));
    const unchecked = (await routes.handle({ ...js, method: "diagnostics" }, true)) as {
      diagnostics: { code: number | string }[];
    };
    strict.ok(!unchecked.diagnostics.some((item) => item.code === 2322), JSON.stringify(unchecked));
    const hover = (await routes.handle({ ...js, method: "hover", position: { line: 3, character: 7 } }, true)) as {
      result: unknown;
    };
    strict.match(JSON.stringify(hover.result), /string/u);
    await routes.close();
    await writeFile(projectFile, config(true));
    routes = createRoutes();
    const checked = (await routes.handle({ ...js, method: "diagnostics" }, true)) as {
      diagnostics: { code: number | string }[];
    };
    strict.ok(
      checked.diagnostics.some((item) => item.code === 2322),
      JSON.stringify(checked),
    );
    const copyHelperPath = join(temporary, "copy-helper.ts");
    const copyTargetPath = join(temporary, "copy-target.ts");
    await writeFile(copyHelperPath, "export const shared = { value: 1 };");
    await writeFile(copyTargetPath, 'import { shared } from "./copy-helper.js";\nshared.value;');
    const copyHelper = await files.read(relative(root, copyHelperPath));
    const copyTarget = await files.read(relative(root, copyTargetPath));
    const targetRequest = { ...copyTarget, method: "hover", position: { line: 1, character: 8 } };
    const baseline = (await routes.handle(targetRequest, true)) as { result: unknown };
    strict.match(JSON.stringify(baseline.result), /number/u);
    const workingCopies = [{ ...copyHelper, source: 'export const shared = { value: "unsaved" };' }];
    const overlay = (await routes.handle({ ...targetRequest, workingCopies }, true)) as {
      result: unknown;
      workingCopyHash: string;
    };
    strict.match(JSON.stringify(overlay.result), /string/u);
    const { contentHash } = await import("../src/files.js");
    strict.equal(overlay.workingCopyHash, contentHash(JSON.stringify(workingCopies)));
    const secondTargetPath = join(temporary, "copy-target-b.ts");
    await writeFile(secondTargetPath, copyTarget.source);
    const secondTarget = await files.read(relative(root, secondTargetPath));
    const [numberContext, stringContext] = (await Promise.all([
      routes.handle(
        { ...targetRequest, workingCopies: [{ ...copyHelper, source: "export const shared = { value: 456 };" }] },
        true,
      ),
      routes.handle({ ...secondTarget, method: "hover", position: { line: 1, character: 8 }, workingCopies }, true),
    ])) as [{ result: unknown }, { result: unknown }];
    strict.match(JSON.stringify(numberContext.result), /number/u);
    strict.match(JSON.stringify(stringContext.result), /string/u);
    const discarded = (await routes.handle(targetRequest, true)) as { result: unknown };
    strict.match(JSON.stringify(discarded.result), /number/u);
    strict.equal((await files.read(copyHelper.file)).source, copyHelper.source);
    await routes.handle({ ...targetRequest, workingCopies }, true);
    await rm(copyHelperPath);
    const deletedHelper = (await routes.handle({ ...targetRequest, method: "diagnostics" }, true)) as {
      diagnostics: { code: number | string }[];
    };
    strict.ok(
      deletedHelper.diagnostics.some((item) => item.code === 2307),
      JSON.stringify(deletedHelper),
    );
    const jsxPath = join(temporary, "view.jsx");
    await writeFile(jsxPath, 'const value = { label: "JSX" };\nconst view = <span>{value.label}</span>;\nvalue.label;');
    const jsx = (await routes.handle(
      { ...(await files.read(relative(root, jsxPath))), method: "hover", position: { line: 2, character: 7 } },
      true,
    )) as { result: unknown; diagnostics: { code: number | string }[] };
    strict.match(JSON.stringify(jsx.result), /string/u);
    strict.ok(!jsx.diagnostics.some((item) => item.code === 1005), JSON.stringify(jsx));
    const taggedPath = join(temporary, "tagged.js");
    await writeFile(
      taggedPath,
      'import { sql } from "@typed-sql/postgres";\nconst q = sql`SELECT id FROM users`;\nconst result = q;\nresult;',
    );
    const tagged = (await routes.handle(
      { ...(await files.read(relative(root, taggedPath))), method: "diagnostics" },
      true,
    )) as { diagnostics: { code: number | string }[] };
    strict.deepEqual(tagged.diagnostics, [], JSON.stringify(tagged));
    const inferred = (await routes.handle(
      { ...(await files.read(relative(root, taggedPath))), method: "hover", position: { line: 3, character: 2 } },
      true,
    )) as { result: unknown };
    strict.match(JSON.stringify(inferred.result), /id: number/u);
    strict.doesNotMatch(JSON.stringify(inferred.result), /unknown/u);
    const wrongParameter = (await routes.handle(
      {
        ...(await files.read(relative(root, taggedPath))),
        source:
          'import { sql } from "@typed-sql/postgres";\nconst q = sql`SELECT id FROM users WHERE id = ${"wrong"}`;\nq;',
        method: "diagnostics",
      },
      true,
    )) as { diagnostics: { code: number | string }[] };
    strict.ok(
      wrongParameter.diagnostics.some((item) => item.code === 2345),
      JSON.stringify(wrongParameter),
    );
    for (const [sourceExtension, specifierExtension, targetExtension] of [
      ["ts", "js", "ts"],
      ["mts", "mjs", "mts"],
      ["cts", "cjs", "cts"],
    ]) {
      const file = join(temporary, `consumer.${sourceExtension}`);
      const source = `import { typed } from "./helper.${specifierExtension}";\ntyped.label;`;
      await writeFile(file, source);
      const definition = (await routes.handle(
        {
          ...(await files.read(relative(root, file))),
          method: "definition",
          position: { line: 0, character: source.indexOf("helper.") + 2 },
        },
        true,
      )) as { result: { uri: string }[] };
      strict.ok(
        definition.result.some((item) => item.uri === pathToFileURL(join(temporary, `helper.${targetExtension}`)).href),
        JSON.stringify(definition),
      );
    }
  } finally {
    await routes?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
