import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../model/canonical.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Hash the complete private normalizer source tree and its pinned direct dependency declaration. */
export function normalizerRevision() {
  const files = { "package.json": readFileSync(join(root, "package.json"), "utf8").replaceAll("\r\n", "\n") };
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files[relative(root, path).split(sep).join("/")] = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
      else throw new TypeError(`Catalog normalizer source is not a regular file: ${path}`);
    }
  }
  visit(join(root, "src"));
  return hash(files);
}
