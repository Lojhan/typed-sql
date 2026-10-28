import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { analyzeSqlFile, loadSqlFileProject } from "./sql-file.js";

const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
// Older releases cannot safely mix tsx's async config loader with synchronous CommonJS hooks.
if (!(major > 25 || (major === 25 && minor >= 1) || (major === 24 && (minor > 11 || (minor === 11 && patch >= 1))))) {
  throw new Error(
    "@typed-sql/ts-bridge/sql-register requires Node.js 24.11.1 or newer (Node.js 25 requires 25.1.0); other typed-sql entrypoints retain their normal runtime support.",
  );
}

// Evaluate configuration on the main thread before installing synchronous hooks.
// Config may itself use tsx's async loader; evaluating it inside an async loader
// worker would recursively try to register another worker loader.
const project = await loadSqlFileProject(process.cwd());
nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".sql")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: analyzeSqlFile(readFileSync(fileURLToPath(url), "utf8"), project).runtime,
    };
  },
});
