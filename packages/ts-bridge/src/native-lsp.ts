import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function typescriptPreviewCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@typed-sql/typescript-preview/package.json")), "bin", "tsc");
}
