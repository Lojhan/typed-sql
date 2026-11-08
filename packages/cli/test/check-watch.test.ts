import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { startWatchedCli } from "../../../test/helpers/watch-cli.js";
import { execute, fixture } from "./helpers/contract-fixture.js";

const cli = fileURLToPath(new URL("../dist/packages/cli/src/cli.js", import.meta.url));
async function watching(
  directory: string,
  test: (pass: (edit?: () => Promise<void>) => Promise<string>) => Promise<void>,
) {
  const watcher = startWatchedCli(cli, ["--frozen"], { cwd: directory });
  try {
    await test((edit) => watcher.pass(edit));
  } finally {
    strict.equal(await watcher.close(), 143);
  }
}

await describe("CLI watch checks", async () => {
  await it("checks new sources, recovers from TypeScript errors and ignores cache writes without touching durable inputs", async () => {
    await fixture(async (directory) => {
      const manifest = join(directory, "generated/contracts/manifest.json"),
        before = await readFile(manifest, "utf8"),
        sourceFile = join(directory, "src/query.ts"),
        source = await readFile(sourceFile, "utf8");
      await watching(directory, async (pass) => {
        strict.match(await pass(), /Frozen checked 1 project\(s\), 1 query\(s\)/u);
        const failed = await pass(() => writeFile(sourceFile, `${source}\nconst invalid: string = 42;`));
        strict.match(failed, /TS2322/u);
        strict.match(failed, /check finished \(1\)/u);
        strict.match(await pass(() => writeFile(sourceFile, source)), /check finished \(0\)/u);
        const fresh = await pass(() => writeFile(join(directory, "src/new.ts"), source));
        strict.match(fresh, /2 query\(s\)/u);
        strict.match(fresh, /check finished \(0\)/u);
        await mkdir(join(directory, ".typed-sql/cache"), { recursive: true });
        await writeFile(join(directory, ".typed-sql/cache/ignored.ts"), "this must not initiate a check");
        // An ignored cache event must not leave an extra pass queued before the next explicit edit.
        await new Promise((resolve) => setTimeout(resolve, 700));
        const next = await pass(() => writeFile(sourceFile, `${source}\nconst next: string = 42;`));
        strict.match(next, /TS2322/u);
      });
      strict.equal(await readFile(manifest, "utf8"), before);
    });
  });
  await it("observes an external schema and fresh configuration dependencies", async () => {
    await fixture(async (directory) => {
      const external = await mkdtemp(join(dirname(directory), ".typed-sql-watch-input-"));
      try {
        const configFile = join(directory, "typed-sql.config.mjs"),
          original = await readFile(configFile, "utf8"),
          schemaFile = join(external, "schema.json"),
          schema = await readFile(join(directory, "schema.json"), "utf8"),
          dependency = join(external, "settings.mjs");
        await writeFile(schemaFile, schema);
        await writeFile(dependency, 'export const projects=["tsconfig.json"];');
        await writeFile(
          configFile,
          `import {projects} from ${JSON.stringify(dependency)};\n${original.replace('file:"schema.json"', `file:${JSON.stringify(schemaFile)}`).replace('projects:["tsconfig.json"]', "projects")}`,
        );
        await watching(directory, async (pass) => {
          strict.match(await pass(), /check finished \(0\)/u);
          strict.match(await pass(() => writeFile(schemaFile, '{"dialect":"wrong"}')), /check finished \(1\)/u);
          strict.match(await pass(() => writeFile(schemaFile, schema)), /check finished \(0\)/u);
          strict.match(await pass(() => writeFile(dependency, "export const projects=[];")), /check finished \(1\)/u);
          strict.match(
            await pass(() => writeFile(dependency, 'export const projects=["tsconfig.json"];')),
            /check finished \(0\)/u,
          );
        });
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });
  await it("terminates an active check even when an imported module ignores graceful shutdown", async () => {
    await fixture(async (directory) => {
      const configFile = join(directory, "typed-sql.config.mjs"),
        original = await readFile(configFile, "utf8");
      await writeFile(
        configFile,
        `if(!process.argv.some(arg=>arg.startsWith("--watch"))){
        const fs=await import("node:fs/promises"); await fs.writeFile("watch-child.pid",String(process.pid));
        process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);
      }\n${original}`,
      );
      const child = spawn(process.execPath, [cli, "check", "--watch", "--frozen"], { cwd: directory, stdio: "ignore" });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
      let pid: number | undefined;
      try {
        const deadline = Date.now() + 10_000;
        while (pid === undefined) {
          try {
            pid = Number(await readFile(join(directory, "watch-child.pid"), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (Date.now() > deadline) throw Error("Watch child did not start");
          if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try {
          strict.equal(await closed, 143);
        } finally {
          clearTimeout(timeout);
        }
        strict.throws(
          () => process.kill(pid!, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
        );
      } finally {
        child.kill("SIGKILL");
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }
        await closed;
      }
    });
  });
  await it("rejects watch flags outside checking before loading configuration", async () => {
    await fixture(async (directory) => {
      for (const [command, args] of [
        ["generate", ["--watch"]],
        ["check", ["--watch=false"]],
      ] as const)
        await strict.rejects(execute(directory, [...args], command), (error: unknown) => {
          strict.match((error as { stderr: string }).stderr, /--watch is supported as a boolean check option/u);
          return true;
        });
    });
  });
});
