import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { diagnosticRegistry } from "../../packages/core/src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = [
  "packages/ast/src/compat/parser.ts",
  "packages/ast/src/compat/tokenizer.ts",
  "packages/ast/src/toolkit/cursor.ts",
  "packages/ast/src/toolkit/tokenizer.ts",
  "packages/ast/src/toolkit/types.ts",
  "packages/compiler/src/compiler.ts",
  "packages/compiler/src/manifest.ts",
  "packages/compiler/src/verification.ts",
  "packages/core/src/dialect-capabilities.ts",
  "packages/postgres/src/resolver.ts",
  "packages/postgres/src/capabilities.ts",
  "packages/postgres/src/parser/parser.ts",
  "packages/postgres/src/parser/tokenizer.ts",
  "packages/mysql/src/resolver.ts",
  "packages/mysql/src/capabilities.ts",
  "packages/mysql/src/parser/parser.ts",
  "packages/mysql/src/parser/tokenizer.ts",
  "packages/sqlite/src/capabilities.ts",
  "packages/sqlite/src/resolver.ts",
  "packages/sqlite/src/parser/parser.ts",
  "packages/sqlite/src/parser/tokenizer.ts",
  "packages/cli/src/cli.ts",
];
const reserved = new Set(["TSQ210", "TSQ405"]);

await describe("stable diagnostic contract", async () => {
  await it("registers every diagnostic code emitted by production sources", async () => {
    const emitted = new Set<string>();
    for (const source of sources) {
      const text = await readFile(resolve(workspace, source), "utf8");
      for (const match of text.matchAll(/TSQ\d{3}/gu)) emitted.add(match[0]);
    }
    strict.deepStrictEqual([...new Set([...emitted, ...reserved])].sort(), Object.keys(diagnosticRegistry).sort());
  });
});
