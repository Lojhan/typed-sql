import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createSemanticWorkspace } from "../../website/.vitepress/theme/playground/semantic-service.js";

/** Exercise the browser service with the actual library contracts and TypeScript standard libraries. */
export function createTestWorkspace() {
  const requireWebsite = createRequire(new URL("../../website/package.json", import.meta.url));
  const libraries = join(dirname(requireWebsite.resolve("@typed-sql/browser-typescript/package.json")), "lib");
  const core = new URL("../../packages/core/src/", import.meta.url);
  const declarations: Record<string, string> = {
    "/grammar.d.ts": 'import type { SqlTag } from "./core/query"; export declare const sql: SqlTag;',
  };
  for (const file of readdirSync(core))
    if (file.endsWith(".ts")) declarations[`/core/${file}`] = readFileSync(new URL(file, core), "utf8");
  for (const file of readdirSync(libraries))
    if (/^lib\..*\.d\.ts$/u.test(file)) declarations[`/lib/${file}`] = readFileSync(join(libraries, file), "utf8");
  for (const dialect of ["postgres", "mysql", "sqlite"]) {
    const root = new URL(`../../packages/${dialect}/dist/packages/${dialect}/src/`, import.meta.url);
    for (const file of readdirSync(root))
      if (file.endsWith(".d.ts")) declarations[`/${dialect}/${file}`] = readFileSync(new URL(file, root), "utf8");
  }
  return createSemanticWorkspace(declarations);
}
