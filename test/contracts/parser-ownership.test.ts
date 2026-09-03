import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const grammars = ["postgres", "mysql", "sqlite"] as const;

async function sourceTree(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  await visit(root);
  files.sort();
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

await describe("dialect parser ownership", async () => {
  await it("keeps neutral toolkit sources free of first-party grammar decisions", async () => {
    const neutral = await sourceTree(join(workspace, "packages", "ast", "src", "toolkit"));
    for (const vendor of ["postgres", "postgresql", "mysql", "sqlite"]) {
      strict.ok(!neutral.toLowerCase().includes(vendor), `neutral parser toolkit must not contain ${vendor}`);
    }
    strict.ok(!neutral.includes('syntax: "postgres" | "mysql" | "sqlite"'));
  });

  await it("isolates the legacy parser behind an explicit 3.0 compatibility boundary", async () => {
    const astIndex = await readFile(join(workspace, "packages", "ast", "src", "index.ts"), "utf8");
    const manifest = JSON.parse(await readFile(join(workspace, "packages", "ast", "package.json"), "utf8")) as {
      readonly exports: Readonly<Record<string, string>>;
    };
    strict.match(astIndex, /compat\/parser\.js/u);
    strict.match(astIndex, /removed in typed-sql 3\.0/u);
    strict.strictEqual(manifest.exports["./toolkit"], "./dist/packages/ast/src/toolkit/index.js");
  });

  await it("makes each grammar own its parser, AST, tokenizer, and walker", async () => {
    for (const grammar of grammars) {
      const root = join(workspace, "packages", grammar);
      const production = await sourceTree(join(root, "src"));
      const parser = await sourceTree(join(root, "src", "parser"));
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        readonly dependencies?: Readonly<Record<string, string>>;
      };
      strict.ok(!production.includes('from "@typed-sql/ast"'));
      strict.strictEqual(manifest.dependencies?.["@typed-sql/ast"], "workspace:*");
      strict.match(production, /from "@typed-sql\/ast\/toolkit"/u);
      strict.match(parser, /class Parser/u);
      strict.match(parser, /class Scanner/u);
      strict.match(parser, /export type Statement/u);
      strict.match(parser, /walkStatement/u);
    }
  });
});
