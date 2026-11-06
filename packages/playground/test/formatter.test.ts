import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it, strict } from "poku";
import { WorkspaceError, WorkspaceFiles } from "../src/files.js";
import { WorkspaceFormatter } from "../src/formatter.js";
import { startPlayground } from "../src/server.js";
import { fixture } from "./helpers/fixture.js";

const require = createRequire(import.meta.url);
async function tool(directory: string, name: "@biomejs/biome" | "prettier") {
  const destination = join(directory, "node_modules", name);
  await mkdir(dirname(destination), { recursive: true });
  await symlink(dirname(require.resolve(`${name}/package.json`)), destination, "dir");
}
const code = (expected: string) => (error: unknown) => error instanceof WorkspaceError && error.code === expected;
async function saved(directory: string, file = "query.ts") {
  const files = new WorkspaceFiles(directory, ["playground"], ["playground"]);
  await writeFile(join(directory, "playground", file), "export const saved = 1;\n");
  return {
    files,
    request: {
      file: `playground/${file}`,
      source: 'export function query(){\nconst value={name:"Ada"};\nreturn value;\n}',
      revision: (await files.read(`playground/${file}`)).revision,
    },
  };
}
await describe("repository formatter execution", async () => {
  await it("formats unsaved buffers with real local Biome configuration without saving", async () =>
    fixture(async (directory) => {
      await tool(directory, "@biomejs/biome");
      await writeFile(
        join(directory, "biome.json"),
        JSON.stringify({
          formatter: { indentStyle: "space", indentWidth: 4 },
          javascript: { formatter: { quoteStyle: "single", semicolons: "asNeeded" } },
        }),
      );
      const { files, request } = await saved(directory),
        formatter = new WorkspaceFormatter(files);
      try {
        await strict.rejects(formatter.format(request, false), code("TRUST"));
        await strict.rejects(formatter.format({ ...request, revision: "stale" }, true), code("FILE_CONFLICT"));
        const result = await formatter.format(request, true);
        strict.equal(result.formatter, "biome");
        strict.equal(result.config, "biome.json");
        strict.equal(result.revision, request.revision);
        strict.match(result.source, /^ {4}const value = \{ name: 'Ada' \}$/mu);
        strict.equal(await readFile(join(directory, request.file), "utf8"), "export const saved = 1;\n");
        await strict.rejects(formatter.format({ ...request, file: "../outside.ts" }, true), code("PATH"));
      } finally {
        await formatter.close();
      }
    }));
  await it("uses the nearest config and permits ancestor tools/configs only within a repository boundary", async () =>
    fixture(async (directory) => {
      await mkdir(join(directory, ".git"));
      await tool(directory, "@biomejs/biome");
      await writeFile(
        join(directory, "biome.json"),
        JSON.stringify({ formatter: { indentStyle: "space", indentWidth: 4 } }),
      );
      const child = join(directory, "child");
      await mkdir(join(child, "playground"), { recursive: true });
      const { files, request } = await saved(child),
        formatter = new WorkspaceFormatter(files);
      try {
        const inherited = await formatter.format(request, true);
        strict.equal(inherited.config, "../biome.json");
        strict.match(inherited.source, /^ {4}const/mu);
        await writeFile(
          join(child, "playground/biome.json"),
          JSON.stringify({ formatter: { indentStyle: "space", indentWidth: 2 } }),
        );
        const local = await formatter.format(request, true);
        strict.equal(local.config, "playground/biome.json");
        strict.match(local.source, /^ {2}const/mu);
        await mkdir(join(child, ".git"));
        await strict.rejects(formatter.format(request, true), code("FORMATTER_INSTALL"));
      } finally {
        await formatter.close();
      }
    }));
  await it("rejects disabled or ignored Biome input and never pretends unsupported SQL was formatted", async () =>
    fixture(async (directory) => {
      await tool(directory, "@biomejs/biome");
      const { files, request } = await saved(directory),
        formatter = new WorkspaceFormatter(files);
      try {
        await writeFile(join(directory, "biome.json"), JSON.stringify({ formatter: { enabled: false } }));
        await strict.rejects(formatter.format(request, true), code("FORMATTER_DISABLED"));
        await writeFile(join(directory, "biome.json"), JSON.stringify({ files: { includes: ["**", "!**/query.ts"] } }));
        await strict.rejects(formatter.format(request, true), code("FORMATTER_IGNORED"));
        await writeFile(join(directory, "biome.json"), "{}");
        await writeFile(join(directory, "playground/query.sql"), "select 1;");
        await strict.rejects(
          formatter.format(
            {
              file: "playground/query.sql",
              source: "select  1;",
              revision: (await files.read("playground/query.sql")).revision,
            },
            true,
          ),
          code("FORMATTER_DISABLED"),
        );
      } finally {
        await formatter.close();
      }
    }));
  await it("honors real Prettier package.json configuration and repository .prettierignore", async () =>
    fixture(async (directory) => {
      await tool(directory, "prettier");
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ type: "module", prettier: { singleQuote: true, semi: false, tabWidth: 3 } }),
      );
      const { files, request } = await saved(directory),
        formatter = new WorkspaceFormatter(files);
      try {
        const result = await formatter.format(request, true);
        strict.equal(result.formatter, "prettier");
        strict.equal(result.config, "package.json");
        strict.match(result.source, /^ {3}const value = \{ name: 'Ada' \}$/mu);
        await writeFile(join(directory, ".prettierignore"), "playground/query.ts\n");
        await strict.rejects(formatter.format(request, true), code("FORMATTER_IGNORED"));
        strict.equal(await readFile(join(directory, request.file), "utf8"), "export const saved = 1;\n");
      } finally {
        await formatter.close();
      }
    }));
  await it("falls back to explicit Prettier only when Biome itself reports formatting disabled", async () =>
    fixture(async (directory) => {
      await tool(directory, "@biomejs/biome");
      await tool(directory, "prettier");
      await writeFile(
        join(directory, "biome.jsonc"),
        '// lint-only repository config\n{"formatter":{"enabled":false},}',
      );
      await writeFile(join(directory, ".prettierrc"), JSON.stringify({ singleQuote: true, semi: false }));
      const { files, request } = await saved(directory),
        formatter = new WorkspaceFormatter(files);
      try {
        const result = await formatter.format(request, true);
        strict.equal(result.formatter, "prettier");
        strict.equal(result.config, ".prettierrc");
        strict.match(result.source, /name: 'Ada'/u);
        await writeFile(
          join(directory, "biome.jsonc"),
          JSON.stringify({ files: { includes: ["**", "!**/query.ts"] } }),
        );
        await strict.rejects(formatter.format(request, true), code("FORMATTER_IGNORED"));
        await writeFile(join(directory, "biome.jsonc"), "{}");
        strict.equal((await formatter.format(request, true)).formatter, "biome");
      } finally {
        await formatter.close();
      }
    }));
  await it("rejects package.json formatter config symlinks outside the repository", async () =>
    fixture(async (directory) => {
      const child = join(directory, "child");
      await mkdir(join(child, ".git"), { recursive: true });
      await mkdir(join(child, "playground"));
      await symlink(join(directory, "package.json"), join(child, "package.json"));
      const { files, request } = await saved(child),
        formatter = new WorkspaceFormatter(files);
      try {
        await strict.rejects(formatter.format(request, true), code("FORMATTER_CONFIG"));
      } finally {
        await formatter.close();
      }
    }));
  await it("requires config and installed local tool rather than consulting a global executable", async () =>
    fixture(async (directory) => {
      const { files, request } = await saved(directory),
        formatter = new WorkspaceFormatter(files);
      try {
        await strict.rejects(formatter.format(request, true), code("FORMATTER_CONFIG"));
        await writeFile(join(directory, "biome.json"), "{}");
        await strict.rejects(formatter.format(request, true), code("FORMATTER_INSTALL"));
        await writeFile(join(directory, "biome.json"), "x".repeat(1024 * 1024 + 1));
        await strict.rejects(formatter.format(request, true), code("FORMATTER_CONFIG"));
        await strict.rejects(
          formatter.format({ ...request, source: "x".repeat(512 * 1024 + 1) }, true),
          code("FILE_LIMIT"),
        );
      } finally {
        await formatter.close();
      }
    }));
  await it("bounds child output/time and detects disk edits while formatting", async () =>
    fixture(async (directory) => {
      const packageRoot = join(directory, "node_modules/@biomejs/biome");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "@biomejs/biome", bin: { biome: "cli.cjs" } }),
      );
      await writeFile(
        join(packageRoot, "cli.cjs"),
        `const fs=require('node:fs');let source='';process.stdin.on('data',data=>source+=data);process.stdin.on('end',()=>{const file=process.argv.find(value=>value.startsWith('--stdin-file-path=')).slice('--stdin-file-path='.length);if(file.endsWith('slow.ts'))setTimeout(()=>process.stdout.write(source),5000);else if(file.endsWith('huge.ts'))process.stdout.write('x'.repeat(600000));else if(file.endsWith('empty.ts')){}else if(file.endsWith('external.ts')){fs.writeFileSync(file,'external edit');process.stdout.write(source);}else if(file.endsWith('config.ts')){const config=process.argv.find(value=>value.startsWith('--config-path=')).slice('--config-path='.length);fs.writeFileSync(config,'{"formatter":{"enabled":false}}');process.stdout.write(source);}else process.stdout.write(source);});`,
      );
      await writeFile(join(directory, "biome.json"), "{}");
      for (const name of ["empty.ts", "huge.ts", "external.ts", "config.ts", "slow.ts"])
        await writeFile(join(directory, "playground", name), "const x=1;");
      const files = new WorkspaceFiles(directory, ["playground"], ["playground"]),
        formatter = new WorkspaceFormatter(files, 250);
      const request = async (file: string) => ({
        file: `playground/${file}`,
        source: "const x=2;",
        revision: (await files.read(`playground/${file}`)).revision,
      });
      try {
        await strict.rejects(formatter.format(await request("empty.ts"), true), code("FORMATTER_EMPTY"));
        await strict.rejects(formatter.format(await request("huge.ts"), true), code("FORMATTER_OUTPUT"));
        await strict.rejects(formatter.format(await request("external.ts"), true), code("FILE_CONFLICT"));
        await strict.rejects(formatter.format(await request("config.ts"), true), code("FORMATTER_CONFIG_CHANGED"));
        await writeFile(join(directory, "biome.json"), "{}");
        await strict.rejects(formatter.format(await request("slow.ts"), true), code("FORMATTER_TIMEOUT"));
        const first = formatter.format(await request("slow.ts"), true),
          second = formatter.format(await request("slow.ts"), true);
        await strict.rejects(formatter.format(await request("slow.ts"), true), code("FORMATTER_BUSY"));
        await Promise.allSettled([first, second]);
      } finally {
        await formatter.close();
      }
      await strict.rejects(formatter.format(await request("slow.ts"), true), code("FORMATTER_CLOSED"));
    }));
  await it("authenticates formatter route and returns buffer-only formatting after explicit trust", async () =>
    fixture(async (directory) => {
      await tool(directory, "@biomejs/biome");
      await writeFile(join(directory, "biome.json"), "{}");
      const { request } = await saved(directory);
      const host = await startPlayground({ config: join(directory, "typed-sql.config.mjs") });
      const post = (route: string, body: unknown) =>
        fetch(`${host.origin}/api/${route}`, {
          method: "POST",
          headers: { "x-typed-sql-session": host.token, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      try {
        strict.equal((await fetch(`${host.origin}/api/format`, { method: "POST" })).status, 403);
        strict.equal((await post("format", request)).status, 403);
        await post("trust", { enable: true });
        const response = await post("format", request);
        strict.equal(response.status, 200);
        strict.equal((await response.json()).formatter, "biome");
        strict.equal(await readFile(join(directory, request.file), "utf8"), "export const saved = 1;\n");
      } finally {
        await host.close();
      }
    }));
});
