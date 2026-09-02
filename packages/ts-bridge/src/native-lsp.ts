import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertTypeScriptPreviewVersion } from "./compatibility.js";

export function typescriptPreviewCliPath(): string {
  assertTypeScriptPreviewVersion();
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@typed-sql/typescript-preview/package.json")), "bin", "tsc");
}
