import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinGenerators } from "../../tools/grammar-catalog/src/generate/index.mjs";
import { groupCatalog } from "../../tools/grammar-catalog/src/model/groups.mjs";
import { CATALOG_SCHEMA_DOCUMENT } from "../../tools/grammar-catalog/src/model/schema.mjs";
import {
  assertProjectionPath,
  CATALOG_GENERATED_HEADER,
  isCatalogProjection,
  ownedCatalogProjections,
  readCatalogManifest,
} from "./lifecycle.mjs";
import { normalizedCorpus } from "./model.mjs";
import { generationReport, renderGenerationReport } from "./report.mjs";

export { decodeFunctions, validateParserPolicy } from "../../tools/grammar-catalog/src/generate/common.mjs";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const header = CATALOG_GENERATED_HEADER;

function workspacePath(root, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\"))
    throw new TypeError("Catalog paths must be workspace-relative");
  const result = resolve(root, path),
    local = relative(root, result);
  if (!local || local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local))
    throw new TypeError(`Catalog path escapes the workspace: ${path}`);
  return result;
}

/**
 * Registered contributions own SQL and emitted contracts. This runner owns deterministic I/O.
 * @param {{check?: boolean, materialize?: boolean, root?: string, registry?: ReturnType<typeof import('../../tools/grammar-catalog/src/registry.mjs').createMapperRegistry>, contributions?: Record<string, unknown>, requiredTargets?: {dialect: string, version: string}[]}} options
 */
export async function generateCatalogs(corpus, options = {}) {
  const {
    check = false,
    materialize = false,
    root = defaultRoot,
    registry = builtinGenerators,
    requiredTargets,
  } = options;
  if (materialize && !check) throw new TypeError("Materialization requires provenance checking");
  const changed = [],
    outputs = [],
    owners = new Map(),
    plans = new Map(),
    inputs = {};
  const reports = ["grammar/catalog/generation.json", "planning/language-audit/generation.md"];
  const ownershipKey = (file) => file.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  for (const path of reports) owners.set(ownershipKey(workspacePath(root, path)), "$report");
  const { catalog, groups } = normalizedCorpus(corpus, registry);
  const semanticGroups = groupCatalog(catalog);
  inputs.model = {
    schemaDigest: catalog.schemaDigest,
    normalizerDigest: catalog.normalizerDigest,
    inputDigest: catalog.inputDigest,
  };
  async function emit(owner, path, text) {
    const file = workspacePath(root, path);
    const key = ownershipKey(file);
    if (owners.has(key))
      throw new TypeError(`Catalog output has multiple emitters: ${path} (${owners.get(key)}, ${owner})`);
    if (typeof text !== "string") throw new TypeError(`Catalog emitter returned non-text output: ${owner}`);
    if (isCatalogProjection(path) && !text.startsWith(header))
      throw new TypeError(`Catalog projection requires the generated ownership header: ${path}`);
    owners.set(key, owner);
    outputs.push(path);
    plans.set(file, { path, text });
  }
  for (const target of requiredTargets ?? [])
    if (!groups.some((group) => group.dialect === target.dialect && group.version === target.version))
      throw new Error(`Missing native generation input: ${target.dialect} ${target.version}`);
  await emit("$schema", "grammar/catalog/format.schema.json", `${JSON.stringify(CATALOG_SCHEMA_DOCUMENT, null, 2)}\n`);
  for (const id of registry.ids) {
    const mapper = registry.get(id);
    if (typeof mapper.generateCatalog !== "function") throw new TypeError(`Missing catalog emitter: ${id}`);
    const supplemental = options.contributions?.[id] ?? {};
    inputs[`${id}/supplemental`] = supplemental;
    await mapper.generateCatalog({
      id,
      catalog,
      groups: groups.filter((group) => group.dialect === id),
      semanticGroups: semanticGroups.filter((group) => group.grammar === id),
      header,
      supplemental,
      emit: (path, text) => emit(id, path, text),
      input: async (key, path) => {
        const name = `${id}/${key}`;
        if (Object.hasOwn(inputs, name)) throw new TypeError(`Duplicate catalog input: ${name}`);
        const value = JSON.parse(await readFile(workspacePath(root, path), "utf8"));
        inputs[name] = value;
        return value;
      },
    });
  }
  const outputDigests = Object.fromEntries(
    [...plans.values()].map(({ path, text }) => [
      path,
      `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    ]),
  );
  const report = generationReport(corpus, groups, inputs, outputs, catalog, outputDigests);
  plans.set(workspacePath(root, reports[0]), { path: reports[0], text: `${JSON.stringify(report, null, 2)}\n` });
  plans.set(workspacePath(root, reports[1]), { path: reports[1], text: renderGenerationReport(report) });
  const updates = [],
    missingProjections = [];
  const previous = await readCatalogManifest(root);
  const retired = await ownedCatalogProjections(root, previous, (path) => !outputs.includes(path));
  for (const [file, plan] of plans) {
    if (isCatalogProjection(plan.path)) await assertProjectionPath(root, plan.path);
    const current = await readFile(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (current === undefined || !current.equals(Buffer.from(plan.text))) {
      changed.push(plan.path);
      const missingProjection = current === undefined && isCatalogProjection(plan.path);
      if (missingProjection) missingProjections.push(plan.path);
      updates.push({ file, text: plan.text, missingProjection });
    }
  }
  const stale = materialize ? changed.filter((path) => !missingProjections.includes(path)) : changed;
  if (check && (stale.length || retired.length))
    throw new Error(`Generated catalogs are stale; run pnpm catalog:generate:\n${[...stale, ...retired].join("\n")}`);
  if (!check || materialize) {
    const staged = [];
    try {
      for (const { file, text, missingProjection } of updates) {
        if (check && !missingProjection) continue;
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.typed-sql-${randomUUID()}.tmp`;
        staged.push({ file, temporary, text });
        await writeFile(temporary, text, { flag: "wx" });
      }
      if (!check) for (const path of retired) await rm(workspacePath(root, path));
      // Reports are last. Materialization publishes complete files without overwriting a race winner.
      for (const { file, temporary, text } of staged) {
        if (!materialize) await rename(temporary, file);
        else
          try {
            await link(temporary, file);
          } catch (error) {
            if (error.code !== "EEXIST" || !(await readFile(file)).equals(Buffer.from(text))) throw error;
          }
      }
    } finally {
      await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
    }
  }
  return { groups, changed, materialized: materialize ? missingProjections : [], retired };
}
