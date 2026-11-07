import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCaptureProvenance } from "../../tools/grammar-catalog/src/provenance/capture.mjs";
import { reviewTarget } from "./inventory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytesDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function extractorManifest() {
  const files = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files[relative(root, file).split(sep).join("/")] = bytesDigest(await readFile(file));
      else throw new TypeError(`Nonregular capture extractor input: ${file}`);
    }
  }
  for (const path of ["scripts/language-audit", "tools/grammar-catalog/src"]) await visit(join(root, path));
  if (process.argv[1]) {
    const file = resolve(process.argv[1]),
      path = relative(root, file).split(sep).join("/");
    if (path.startsWith("../") || isAbsolute(path))
      throw new TypeError("Capture producer entrypoint is outside this workspace");
    files[path] = bytesDigest(await readFile(file));
  }
  return {
    id: "typed-sql/native-language-inventory",
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    dependencyLock: bytesDigest(await readFile(join(root, "pnpm-lock.yaml"))),
    runtime: { name: "node", version: process.version },
  };
}
/** Attach only after all inventory mutations. Recognition is a separate qualification channel.
 * @param {ReturnType<typeof import('../../tools/grammar-catalog/src/registry.mjs').createMapperRegistry> | undefined} [registry]
 */
export async function attachNativeProvenance(input, registry = undefined) {
  input.provenance = createCaptureProvenance(
    { grammar: input.dialect, target: reviewTarget(input, registry), categories: input.categories },
    await extractorManifest(),
  );
  return input.provenance;
}
