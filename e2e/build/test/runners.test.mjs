import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { consumer, execution, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer([
  "esbuild",
  "jest",
  "babel-jest",
  "@babel/preset-env",
  "@babel/preset-typescript",
  "vitest",
  "vite",
  "mocha",
  "ava",
  "poku",
  "tsx",
]);
try {
  await describe("Packed test runner integrations", async () => {
    for (const mode of ["esm", "cjs", "babel"]) {
      await it(`Jest ${mode} compiles SQL and inline plans`, async () => {
        const root = await fixture.project(`jest-${mode}`);
        await writeEntry(root);
        await writeFile(join(root, "verify.ts"), execution);
        const mock =
          mode === "babel"
            ? `import {marker} from "./mocked.ts"; jest.mock("./mocked.ts",()=>({marker:"mocked"})); expect(marker).toBe("mocked");`
            : "";
        await writeFile(
          join(root, "mocked.ts"),
          'throw new Error("Babel mock hoisting was lost"); export const marker="real";',
        );
        await writeFile(
          join(root, "query.test.ts"),
          `import {test,expect,jest} from "@jest/globals"; import query from "./query.sql"; import {inline,repeated,conditional} from "./inline.ts"; import {verify} from "./verify.ts"; ${mock}\ntest("executes compiled plans",async()=>{await verify({query,inline,repeated,conditional});});`,
        );
        const transformer =
          mode === "babel"
            ? {
                module: "babel-jest",
                options: {
                  presets: [
                    ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
                    ["@babel/preset-typescript", { allExtensions: true }],
                  ],
                },
              }
            : undefined;
        await writeFile(
          join(root, "jest.config.mjs"),
          `export default ${JSON.stringify({ rootDir: root, testMatch: ["**/*.test.ts"], ...(mode === "esm" ? { extensionsToTreatAsEsm: [".ts", ".sql"] } : {}), transform: { "\\.(?:sql|[cm]?tsx?)$": ["@typed-sql/build/jest", { cwd: root, ...(transformer ? { transformer } : {}) }] }, dependencyExtractor: "@typed-sql/build/jest-dependencies", coverageProvider: mode === "babel" ? "babel" : "v8" })};`,
        );
        const run = async (extra = []) =>
          fixture.command(root, "pnpm", ["exec", "jest", "--runInBand", ...extra], {
            env: { NODE_OPTIONS: "--experimental-vm-modules", TYPED_SQL_BUILD_CWD: root },
          });
        const passing = await run(mode === "babel" ? ["--coverage"] : []);
        assert.match(passing.output, /1 passed/u);
        if (mode === "babel") assert.match(passing.output, /inline\.ts/u);
        // Reuse Jest's on-disk transform cache after an imported config dependency changes.
        await writeFile(join(root, "policy.mjs"), 'export const integer="bigint";');
        const invalid = await fixture.command(root, "pnpm", ["exec", "jest", "--runInBand"], {
          allowFailure: true,
          env: { NODE_OPTIONS: "--experimental-vm-modules", TYPED_SQL_BUILD_CWD: root },
        });
        assert.notEqual(invalid.code, 0);
        assert.match(invalid.output, /policies differ/iu);
      });
    }
    for (const pool of ["forks", "threads"]) {
      await it(`Vitest ${pool} reuses the Vite adapter`, async () => {
        const root = await fixture.project(`vitest-${pool}`);
        await writeEntry(root);
        await writeFile(join(root, "verify.mjs"), execution);
        await writeFile(
          join(root, "query.test.ts"),
          'import {test} from "vitest"; import query from "./query.sql"; import {inline,repeated,conditional} from "./inline.ts"; import {verify} from "./verify.mjs"; test("executes compiled plans",async()=>{await verify({query,inline,repeated,conditional});});',
        );
        await writeFile(
          join(root, "vitest.config.mjs"),
          `import {defineConfig} from "vitest/config"; import {typedSql} from "@typed-sql/build/vite"; export default defineConfig({plugins:[typedSql()],test:{pool:${JSON.stringify(pool)},maxWorkers:1}});`,
        );
        assert.match((await fixture.command(root, "pnpm", ["exec", "vitest", "run"])).output, /1 passed/u);
      });
    }
    for (const runner of ["node", "mocha", "ava", "poku"]) {
      await it(`${runner} imports SQL through the Node preload`, async () => {
        const root = await fixture.project(`preload-${runner}`);
        await writeFile(join(root, "verify.mjs"), execution);
        const body = 'import query from "./query.sql"; import {verify} from "./verify.mjs";';
        const test =
          runner === "ava"
            ? 'import test from "ava"; test("executes SQL",async t=>{await verify({query}); t.pass();});'
            : runner === "mocha"
              ? 'import {it} from "mocha"; it("executes SQL",async()=>{await verify({query});});'
              : runner === "node"
                ? 'import {test} from "node:test"; test("executes SQL",async()=>{await verify({query});});'
                : 'import {it} from "poku"; await it("executes SQL",async()=>{await verify({query});});';
        await writeFile(join(root, "query.test.mjs"), `${body}\n${test}`);
        if (runner === "ava")
          await writeFile(
            join(root, "ava.config.mjs"),
            'export default {files:["query.test.mjs"],nodeArguments:["--import=@typed-sql/build/register"]};',
          );
        const result =
          runner === "node"
            ? await fixture.command(root, process.execPath, [
                "--import=@typed-sql/build/register",
                "--test",
                "query.test.mjs",
              ])
            : await fixture.command(
                root,
                "pnpm",
                [
                  "exec",
                  runner,
                  ...(runner === "mocha"
                    ? ["--node-option", "import=@typed-sql/build/register", "query.test.mjs"]
                    : runner === "poku"
                      ? ["query.test.mjs", "--enforce"]
                      : []),
                ],
                { env: runner === "poku" ? { NODE_OPTIONS: "--import=@typed-sql/build/register" } : {} },
              );
        assert.match(result.output, /pass|✔|✓|●/u);
      });
    }
  });
} finally {
  await fixture.close();
}
