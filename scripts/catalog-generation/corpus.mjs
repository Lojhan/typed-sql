import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { CATEGORIES, hash, reviewTarget, serialize } from "../language-audit/inventory.mjs";
import { summarizeLive } from "../language-audit/live-baseline.mjs";
import { signatureFacts } from "../language-audit/signatures.mjs";

export const corpusPath = new URL("../../grammar/catalog/upstream.json", import.meta.url);

export function emptyCorpus() {
  return { formatVersion: 1, rows: {}, inventories: {}, targets: {} };
}

export function expandTarget(corpus, entry, registry = builtinMappers) {
  const categories = {};
  for (const category of CATEGORIES) {
    const metadata = entry.categories[category];
    if (!metadata) throw new Error(`Missing captured category: ${category}`);
    if (metadata.status === "unavailable") {
      if (!metadata.reason) throw new Error(`Missing limitation: ${category}`);
      categories[category] = metadata;
      continue;
    }
    const ids = corpus.inventories[metadata.fingerprint];
    if (metadata.status !== "observed" || !ids?.length) throw new Error(`Missing captured inventory: ${category}`);
    const rows = ids.map((id) => {
      const row = corpus.rows[id];
      if (!row || hash(row) !== id) throw new Error(`Invalid captured row: ${id}`);
      if (category === "functions" && hash(row.signature) !== hash(signatureFacts(entry.dialect, row, registry)))
        throw new Error(`Invalid captured signature: ${row.name}`);
      return row;
    });
    if (hash(rows) !== metadata.fingerprint) throw new Error(`Invalid captured inventory: ${category}`);
    categories[category] = { ...metadata, rows };
  }
  return { ...entry, categories };
}

export function validateCorpus(corpus, registry = builtinMappers) {
  if (corpus.formatVersion !== 1) throw new Error("Unsupported upstream corpus format");
  for (const [id, entry] of Object.entries(corpus.targets)) {
    registry.get(entry.dialect);
    if (!entry.target?.version) throw new Error(`Invalid captured target: ${id}`);
    if (hash({ dialect: entry.dialect, target: entry.target }) !== id)
      throw new Error(`Invalid captured target identity: ${id}`);
    expandTarget(corpus, entry, registry);
  }
  return corpus;
}

/** @param {string | URL} path */
export async function readCorpus(path = corpusPath, registry = builtinMappers) {
  return validateCorpus(JSON.parse(await readFile(path, "utf8")), registry);
}

/** Fresh matrix captures must also be inputs to the generated runtime catalogs. */
export async function verifyCaptureInput(input, corpus, registry = builtinMappers) {
  summarizeLive(input, registry);
  const source = corpus ?? (await readCorpus(corpusPath, registry));
  const key = hash({ dialect: input.dialect, target: reviewTarget(input, registry) });
  const entry = source.targets[key];
  if (!entry) return { status: "missing", key, reason: "Native context is absent from generation inputs" };
  const changed = CATEGORIES.filter((name) => {
    const { rows: _rows, ...metadata } = input.categories[name];
    return hash(metadata) !== hash(entry.categories[name]);
  });
  return { status: changed.length ? "changed" : "match", key, changedCategories: changed };
}

export async function addCapture(corpus, input, registry = builtinMappers) {
  // Importing native facts does not approve the grammar's current inference. This
  // separation permits regeneration to fix a type disagreement without accepting
  // that disagreement as an audit baseline. CI checks every input against a fresh engine.
  const summary = summarizeLive(input, registry);
  const key = hash({ dialect: summary.dialect, target: summary.target });
  const categories = {};
  for (const category of CATEGORIES) {
    const { rows, ...metadata } = input.categories[category];
    categories[category] = metadata;
    if (!rows) continue;
    const ids = rows.map((row) => {
      const id = hash(row);
      corpus.rows[id] = row;
      return id;
    });
    corpus.inventories[metadata.fingerprint] = ids;
  }
  const entry = { dialect: input.dialect, target: reviewTarget(input, registry), categories };
  corpus.targets[key] = entry;
  validateCorpus({ ...corpus, targets: { [key]: entry } }, registry);
}

/** @param {unknown} corpus
 * @param {string | URL} path */
export async function writeCorpus(corpus, path = corpusPath, registry = builtinMappers) {
  validateCorpus(corpus, registry);
  const inventories = {},
    rows = {};
  for (const entry of Object.values(corpus.targets))
    for (const category of Object.values(entry.categories)) {
      if (category.status !== "observed") continue;
      const ids = corpus.inventories[category.fingerprint];
      inventories[category.fingerprint] = ids;
      for (const id of ids) rows[id] = corpus.rows[id];
    }
  const sorted = (values) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  const compact = {
    formatVersion: 1,
    rows: sorted(rows),
    inventories: sorted(inventories),
    targets: sorted(corpus.targets),
  };
  await mkdir(dirname(path instanceof URL ? path.pathname : path), { recursive: true });
  await writeFile(path, `${serialize(compact)}\n`);
}

export async function importCaptureFiles(paths) {
  let corpus;
  try {
    corpus = await readCorpus();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    corpus = emptyCorpus();
  }
  for (const path of paths) {
    const body = JSON.parse(await readFile(path, "utf8"));
    const input = body.evidence?.languageInventory ?? body.languageInventory ?? body;
    await addCapture(corpus, input);
    for (const profile of body.profiles ?? [])
      if (profile.languageInventory) await addCapture(corpus, profile.languageInventory);
  }
  await writeCorpus(corpus);
  return corpus;
}
