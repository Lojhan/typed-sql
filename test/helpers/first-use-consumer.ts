import { execFile as callback } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { strict } from "poku";

const execFile = promisify(callback);

/** Exercise the actual quickstart using tarballs and ordinary dependencies, without workspace links. */
export async function assertFirstUseConsumer(options: {
  readonly directory: string;
  readonly workspace: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { directory, workspace, env } = options;
  await mkdir(join(directory, "src"), { recursive: true });
  const markdown = await readFile(join(workspace, "docs/getting-started/sqlite.md"), "utf8");
  const blocks = [...markdown.matchAll(/```(\w*)\n([\s\S]*?)```/gu)].map((match) => ({
    language: match[1]!,
    text: match[2]!,
  }));
  const block = (language: string, marker: string): string => {
    const found = blocks.find((entry) => entry.language === language && entry.text.includes(marker));
    strict.ok(found, `SQLite quickstart is missing ${marker}`);
    return found!.text;
  };
  const development = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")).devDependencies as Record<
    string,
    string
  >;
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const install = block("sh", "pnpm add @typed-sql/core");
  for (const line of install.trim().split("\n")) {
    const tokens = line.trim().split(/\s+/u);
    strict.equal(tokens[0], "pnpm");
    strict.equal(tokens[1], "add");
    const dev = tokens[2] === "-D";
    for (const name of tokens.slice(dev ? 3 : 2)) {
      const version = options.dependencies[name] ?? development[name];
      strict.ok(version, `Missing quickstart dependency version for ${name}`);
      (dev ? devDependencies : dependencies)[name] = version!;
    }
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "first-use-consumer",
      private: true,
      type: "module",
      dependencies,
      devDependencies,
      pnpm: { overrides: options.dependencies },
    }),
  );
  await writeFile(join(directory, "tsconfig.json"), block("json", "compilerOptions"));
  await writeFile(join(directory, "typed-sql.config.ts"), block("ts", "defineConfig"));
  const query = block("ts", "export const accountById");
  const execution = block("ts", "console.log(account.email)");
  const main = join(directory, "src/main.ts");
  await writeFile(main, `${query}\n${execution}`);
  await execFile("pnpm", ["install", "--ignore-workspace", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: directory,
    env,
    timeout: 180_000,
  });
  const setup = block("sh", "node --input-type=module <<'JS'");
  const script = setup.slice(setup.indexOf("\n") + 1, setup.lastIndexOf("\nJS"));
  const setupFile = join(directory, ".setup.mjs");
  await writeFile(setupFile, script);
  await execFile(process.execPath, [setupFile], { cwd: directory, env });
  await rm(setupFile);
  const command = async (...args: string[]) =>
    execFile("pnpm", ["exec", "typed-sql", ...args], { cwd: directory, env, timeout: 60_000 });
  await command("generate");
  const first = await command("check", "--project", "tsconfig.json", "--show-types");
  strict.match(first.stdout.replaceAll("\\", "/"), /src\/main\.ts:.*Query</u);
  strict.match(first.stdout, /readonly \[bigint\]/u);
  strict.match(first.stdout, /Checked 1 project/u);
  const run = await execFile("pnpm", ["exec", "tsx", "src/main.ts"], { cwd: directory, env });
  strict.equal(run.stdout.trim(), "ada@example.com");
  await writeFile(join(directory, "src/query.ts"), query);
  const consumer = `import {accountById} from "./query.js";\n${execution}`;
  await writeFile(main, consumer);
  await command("check", "--project", "tsconfig.json");
  await command("check", "--file", "src/main.ts", "--project", "tsconfig.json");
  const invalid = consumer.replace(
    "console.log(account.email)",
    "{ const wrong: number = account.email; console.log(wrong); }",
  );
  await writeFile(main, invalid);
  await strict.rejects(command("check", "--project", "tsconfig.json"), (error: unknown) => {
    strict.ok(error instanceof Error && "stderr" in error);
    strict.match(
      String((error as { stderr: string }).stderr),
      /main\.ts\(\d+,\d+\).*Type 'string' is not assignable to type 'number'/u,
    );
    return true;
  });
  await writeFile(main, consumer);
  await command("init", "--grammar", "sqlite", "--apply");
  const generated = await execFile("pnpm", ["run", "typed-sql:check"], { cwd: directory, env, timeout: 60_000 });
  strict.match(generated.stdout, /Checked 1 project/u);
  strict.deepEqual((await readdir(join(directory, "src"))).sort(), ["main.ts", "query.ts"]);
}
