import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { compileSqlFile } from "@typed-sql/compiler";
import { BuildError } from "./engine.js";
import { loadBuildProject } from "./project.js";

const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
if (!(major > 25 || (major === 25 && minor >= 1) || (major === 24 && (minor > 11 || (minor === 11 && patch >= 1)))))
  throw new Error("@typed-sql/build/register requires Node.js 24.11.1 or newer (Node 25 requires 25.1.0)");
// Evaluate executable config before registering synchronous hooks; config may use an async TS loader.
const project = await loadBuildProject(
  process.env.TYPED_SQL_BUILD_CWD ?? process.cwd(),
  process.env.TYPED_SQL_BUILD_CONFIG,
);
nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".sql")) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const source = readFileSync(file, "utf8");
    const { dialect, typePolicy } = project.loaded.config;
    const result = compileSqlFile({
      source,
      dialect,
      schema: project.snapshot,
      ...(typePolicy === undefined ? {} : { typePolicy }),
    });
    if (result.diagnostics.length > 0)
      throw new BuildError(
        result.diagnostics.map((item) => {
          const prefix = source.slice(0, item.start);
          return {
            file,
            code: `TSQ${item.code}`,
            message: item.messageText.replace(/^TSQ\d+:\s*/u, ""),
            line: prefix.split("\n").length,
            column: prefix.length - prefix.lastIndexOf("\n"),
          };
        }),
      );
    return { format: "module", shortCircuit: true, source: result.runtime };
  },
});
