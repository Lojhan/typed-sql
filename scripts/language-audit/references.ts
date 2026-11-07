import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { CATEGORIES, hash, inventory, serialize } from "./inventory.mjs";
import { builtinReferenceSources } from "./reference-sources/index.js";
import type { ReferenceSourceRegistry } from "./reference-sources/registry.js";
import { signatureFacts } from "./signatures.mjs";

export { extractSqliteStrictTypes } from "./reference-sources/sqlite.js";
export { extractMicrosoftToc } from "./reference-sources/sqlserver.js";
export { textContent } from "./reference-sources/text.js";
export const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/language-audit");

export function extractFunctions(dialect: string, body: string, base: string, registry = builtinReferenceSources) {
  const owner = registry.get(dialect);
  if (!owner.extractFunctions) throw new Error(`No reference function extractor for ${dialect}`);
  return owner.extractFunctions(body, base);
}

export function referenceTargets(registry = builtinReferenceSources) {
  return registry.ids.flatMap((dialect) =>
    registry
      .get(dialect)
      .referenceVersions()
      .map((version) => ({ dialect, version })),
  );
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  // A redirect to another manual cannot qualify the requested version.
  if (response.url !== url) throw new Error(`Unexpected upstream redirect: ${url} -> ${response.url}`);
  return response.text();
}

export async function refreshReferences(
  options: {
    registry?: ReferenceSourceRegistry;
    mappers?: typeof builtinMappers;
    directory?: string;
    download?: (url: string) => Promise<string>;
  } = {},
) {
  const registry = options.registry ?? builtinReferenceSources;
  const destination = options.directory ?? directory;
  const cache = new Map<string, Promise<string>>();
  const results = [];
  for (const { dialect, version } of referenceTargets(registry)) {
    const owner = registry.get(dialect);
    const sources: { url: string; hash: string }[] = [];
    async function page(url: string) {
      let pending = cache.get(url);
      if (!pending) {
        pending = Promise.resolve().then(() => (options.download ?? download)(url));
        cache.set(url, pending);
      }
      const body = await pending;
      sources.push({ url, hash: hash(body) });
      return body;
    }
    if (!owner.collect) throw new Error(`No reference collector for ${dialect}`);
    const collection = await owner.collect(version, page);
    for (const category of Object.keys(collection.categories))
      if (category === "functions" || !CATEGORIES.includes(category))
        throw new Error(`Invalid reference category contribution: ${dialect}/${category}`);
    const distinct = [...new Map(collection.functions.map((row) => [row.name, row])).values()];
    if (distinct.length < owner.minimumFunctions)
      throw new Error(`Suspiciously small ${dialect} inventory: ${distinct.length}`);
    const result = {
      formatVersion: 1,
      dialect,
      target: { version },
      scope: owner.scope,
      sources: sources.sort((a, b) => a.url.localeCompare(b.url)),
      categories: {
        functions: inventory(
          distinct.map((row) => ({
            ...row,
            signature: signatureFacts(dialect, row, options.mappers ?? builtinMappers),
          })),
          "official-reference",
          "documented-functions",
        ),
        ...collection.categories,
      },
    };
    const file = resolve(destination, `${dialect}-${version}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${serialize(result)}\n`);
    results.push(result);
    console.log(`${dialect} ${version}: ${distinct.length} documented function names`);
  }
  return results;
}

export async function loadReferences(options: { registry?: ReferenceSourceRegistry; directory?: string } = {}) {
  const registry = options.registry ?? builtinReferenceSources;
  return Promise.all(
    [
      ...referenceTargets(registry),
      ...registry.ids.flatMap((dialect) =>
        registry
          .get(dialect)
          .captureVersions()
          .map((version) => ({ dialect, version })),
      ),
    ].map(async ({ dialect, version }) =>
      JSON.parse(await readFile(resolve(options.directory ?? directory, `${dialect}-${version}.json`), "utf8")),
    ),
  );
}
