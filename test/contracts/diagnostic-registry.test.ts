import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { diagnosticRegistry } from "../../packages/core/src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = [
  "packages/ast/src/parser.ts",
  "packages/ast/src/tokenizer.ts",
  "packages/compiler/src/compiler.ts",
  "packages/compiler/src/manifest.ts",
  "packages/compiler/src/verification.ts",
  "packages/postgres/src/resolver.ts",
  "packages/mysql/src/resolver.ts",
  "packages/cli/src/cli.ts",
];

await describe("stable diagnostic contract", async () => {
  await it("registers every diagnostic code emitted by production sources", async () => {
    const emitted = new Set<string>();
    for (const source of sources) {
      const text = await readFile(resolve(workspace, source), "utf8");
      for (const match of text.matchAll(/TSQ\d{3}/gu)) emitted.add(match[0]);
    }
    strict.deepStrictEqual([...emitted].sort(), Object.keys(diagnosticRegistry).sort());
  });
});
