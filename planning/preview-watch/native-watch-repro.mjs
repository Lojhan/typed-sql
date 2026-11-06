// Standalone upstream control. No typed-sql, content mapper, SDK or database imports.
// node native-watch-repro.mjs /absolute/path/to/native/tsc [rounds] [early|complete]
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const compiler = resolve(process.argv[2]);
const rounds = Number(process.argv[3] ?? 30);
const early = process.argv[4] === "early";
for (let round = 1; round <= rounds; round++) {
  const directory = await mkdtemp(join(process.env.NATIVE_WATCH_REPRO_ROOT ?? tmpdir(), ".native-ts-watch-repro-"));
  let child;
  let closed;
  let output = "";
  let transcript = "";
  let stage = "initial";
  const started = Date.now();
  try {
    let imports = "";
    for (let index = 0; index < 25; index++) {
      await mkdir(join(directory, `lib${index}`));
      await writeFile(join(directory, `lib${index}/index.ts`), "export const value=1;");
      imports += `import { value as n${index} } from './lib${index}/index.js';\n`;
    }
    const good = `${imports}const value:number=n0;`;
    const main = join(directory, "main.ts");
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
        files: ["main.ts"],
      }),
    );
    await writeFile(main, good);
    child = spawn(compiler, ["-p", directory, "--watch", "--preserveWatchOutput", "--pretty", "false"], {
      env: { ...process.env, TS_WATCH_DEBUG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    closed = new Promise((done) => child.once("close", done));
    const capture = (data) => {
      output += data;
      transcript = `${transcript}[${Date.now() - started}ms ${stage}] ${data}`.slice(-64_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const waitFor = async (pattern) => {
      const deadline = Date.now() + 20_000;
      while (!pattern.test(output)) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Timeout: ${stage}`);
        await new Promise((done) => setTimeout(done, 1));
      }
    };
    await waitFor(/Found 0 errors/u);
    for (let edit = 0; edit < 12; edit++) {
      stage = `edit ${edit}`;
      output = "";
      transcript += `[${Date.now() - started}ms write ${stage}]\n`;
      await writeFile(main, edit % 2 === 0 ? 'const value:number="bad";' : good);
      await waitFor(edit % 2 === 0 ? (early ? /TS2322/u : /Found 1 error/u) : /Found 0 errors/u);
    }
    console.log(`PASS ${early ? "early" : "complete"} round ${round}`);
  } catch (error) {
    console.error(String(error), transcript);
    // Distinguish stale watch output from a real error in the restored source.
    console.error("Source on disk:", (await readFile(join(directory, "main.ts"), "utf8")).slice(-150));
    try {
      await promisify(execFile)(compiler, ["-p", directory, "--pretty", "false"]);
      console.error("Independent one-shot compilation: zero errors");
    } catch (check) {
      console.error("Independent one-shot compilation:", check.stdout, check.stderr);
    }
    process.exitCode = 1;
    break;
  } finally {
    if (child) {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.kill();
      await closed;
      clearTimeout(timeout);
    }
    await rm(directory, { recursive: true, force: true });
  }
}
