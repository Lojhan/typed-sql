import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { EditorLspClient } from "../src/editor-lsp.js";
import { EditorRoutes } from "../src/editor-service.js";
import { WorkspaceFiles } from "../src/files.js";

const fake = `import {writeFileSync} from 'node:fs';let schemaChanges=0;let buffer=Buffer.alloc(0);let text='';let uri='';const send=v=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...v}));process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b)};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){let i=buffer.indexOf('\\r\\n\\r\\n');if(i<0)return;let n=Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,i).toString())[1]);if(buffer.length<i+4+n)return;let v=JSON.parse(buffer.subarray(i+4,i+4+n));buffer=buffer.subarray(i+4+n);
if(v.method==='initialize')send({id:v.id,result:{serverInfo:{name:'fixture'},capabilities:{hoverProvider:true}}});
else if(v.method==='textDocument/didOpen'){text=v.params.textDocument.text;uri=v.params.textDocument.uri}
else if(v.method==='textDocument/didChange')text=v.params.contentChanges[0].text;
else if(v.method==='textDocument/diagnostic')send({id:v.id,result:{kind:'full',items:[]}});
else if(v.method==='workspace/didChangeWatchedFiles')schemaChanges++;
else if(v.method==='textDocument/hover'){if(text==='schema-slow')writeFileSync(process.cwd()+'/hover-started','1');setTimeout(()=>{send({id:v.id,result:{contents:text,schemaChanges}});if(text==='crash')setTimeout(()=>process.exit(0),10)},text.includes('slow')?100:0);}
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
