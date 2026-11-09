import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(workspace, "grammar", "mysql", "catalog", "core.json");
const outputDirectory = join(workspace, "packages", "mysql", "src", "catalog", "generated");
const series = ["8.4", "9.7", "26.7"];
const seriesOrder = new Map(series.map((value, index) => [value, index]));
const allEditions = ["commercial", "community", "enterprise", "source"];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function active(entry, target) {
  const introduced = seriesOrder.get(entry.introduced);
  const selected = seriesOrder.get(target);
  const removed = entry.removed === undefined ? undefined : seriesOrder.get(entry.removed);
  return introduced <= selected && (removed === undefined || selected < removed);
}

function stripVersion(entry) {
  const { introduced: _introduced, removed: _removed, ...catalogEntry } = entry;
  return catalogEntry;
}

function assertVersion(entry, identity) {
  if (!seriesOrder.has(entry.introduced)) throw new TypeError(`${identity} has an unsupported introduced series`);
  if (entry.removed !== undefined) {
    if (!seriesOrder.has(entry.removed) || seriesOrder.get(entry.removed) <= seriesOrder.get(entry.introduced)) {
      throw new TypeError(`${identity} has an invalid removed series`);
    }
  }
}

function unique(entries, collection, memberKey) {
  if (!Array.isArray(entries)) throw new TypeError(`${collection} must be an array`);
  const identities = new Set();
  const members = new Set();
  for (const entry of entries) {
    if (typeof entry.name !== "string" || identities.has(entry.name))
      throw new TypeError(`${collection} names must be unique strings`);
    identities.add(entry.name);
    assertVersion(entry, `${collection}.${entry.name}`);
    const values =
      memberKey === "name" ? [entry.name] : memberKey === "aliases" ? [entry.name, ...entry.aliases] : entry[memberKey];
    if (!Array.isArray(values)) throw new TypeError(`${collection}.${entry.name}.${memberKey} must be an array`);
    for (const value of values) {
      if (typeof value !== "string" || members.has(value))
        throw new TypeError(`${collection} member ${String(value)} is duplicated or invalid`);
      members.add(value);
    }
  }
}

function validate(source) {
  if (source.formatVersion !== 1) throw new TypeError("Unsupported MySQL catalog source format");
  unique(source.types, "types", "aliases");
  unique(source.operators, "operators", "operators");
  unique(source.routines, "routines", "routines");
  unique(source.collations, "collations", "name");
  const typeNames = new Set(source.types.map(({ name }) => name));
  const coercions = new Set();
  for (const coercion of source.coercions) {
    const identity = `${coercion.source}>${coercion.target}`;
    assertVersion(coercion, `coercions.${identity}`);
    if (coercions.has(identity)) throw new TypeError(`Duplicate MySQL coercion ${identity}`);
    if (!typeNames.has(coercion.source) || !typeNames.has(coercion.target))
      throw new TypeError(`MySQL coercion ${identity} references an unknown canonical type`);
    coercions.add(identity);
  }
}

const selectionPath = join(workspace, "grammar/mysql/offline-core.json");
const selectionBytes = await readFile(selectionPath);
const selectionPolicy = JSON.parse(selectionBytes);
if (
  selectionPolicy.formatVersion !== 1 ||
  typeof selectionPolicy.selectionVersion !== "string" ||
  !Array.isArray(selectionPolicy.families) ||
  new Set(selectionPolicy.families).size !== selectionPolicy.families.length
)
  throw new TypeError("Invalid MySQL core family selection");
for (const key of ["structuralForms", "structuralPrefixes"])
  if (
    !Array.isArray(selectionPolicy[key]) ||
    selectionPolicy[key].some((value) => typeof value !== "string" || !value || value !== value.toUpperCase())
  )
    throw new TypeError(`Invalid MySQL ${key}`);
const selectedFamilies = new Set(selectionPolicy.families);
const projections = new Map();
const routineSeries = {};
const codecTypes = {};
const catalogRevisions = {};

function render(source, target) {
  const selected = stable({
    formatVersion: 1,
    series: target,
    types: source.types
      .filter((entry) => active(entry, target))
      .map((entry) => ({ ...stripVersion(entry), aliases: [...entry.aliases].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    coercions: source.coercions
      .filter((entry) => active(entry, target))
      .map((entry) => ({ ...stripVersion(entry), contexts: [...entry.contexts].sort() }))
      .sort((left, right) => `${left.source}>${left.target}`.localeCompare(`${right.source}>${right.target}`)),
    operators: source.operators
      .filter((entry) => active(entry, target))
      .map((entry) => ({ ...stripVersion(entry), operators: [...entry.operators].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    routines: source.routines
      .filter((entry) => active(entry, target))
      .map((entry) => ({
        ...stripVersion(entry),
        routines: [...entry.routines].sort(),
        editions: [...(entry.editions ?? allEditions)].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    collations: source.collations
      .filter((entry) => active(entry, target))
      .map(stripVersion)
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
  const canonical = JSON.stringify(selected);
  const catalog = { ...selected, revision: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  codecTypes[target] = Object.fromEntries(
    catalog.types.flatMap((entry) => [entry.name, ...entry.aliases].map((name) => [name, entry.mapping])),
  );
  catalogRevisions[target] = catalog.revision;
  for (const family of catalog.routines)
    for (const name of family.routines) {
      routineSeries[name] ??= [];
      routineSeries[name].push(target);
    }
  const coreRoutines = catalog.routines.filter((family) => selectedFamilies.has(family.name));
  const additionalRoutines = catalog.routines.filter((family) => !selectedFamilies.has(family.name));
  const core = { ...catalog, routines: coreRoutines };
  core.revision = `sha256:${createHash("sha256")
    .update(JSON.stringify({ ...core, revision: undefined, selectionVersion: selectionPolicy.selectionVersion }))
    .digest("hex")}`;
  const provenance = {
    selectionVersion: selectionPolicy.selectionVersion,
    policyDigest: `sha256:${createHash("sha256").update(selectionBytes).digest("hex")}`,
    sourceRevision: catalog.revision,
  };
  const selection = [...coreRoutines.flatMap((family) => family.routines), ...selectionPolicy.structuralForms].sort();
  const header = "// Generated by scripts/generate-mysql-catalog.mjs. Do not edit.\n";
  projections.set(
    `core/${target}.ts`,
    header +
      `import type {MySqlCoreCatalog} from "../../types.js";\nexport const provenance=${JSON.stringify(provenance)} as const;\nexport const selection:readonly string[]=${JSON.stringify(selection)};\nexport const prefixes:readonly string[]=${JSON.stringify(selectionPolicy.structuralPrefixes)};\nconst catalog=JSON.parse(${JSON.stringify(JSON.stringify(core))}) as MySqlCoreCatalog;\nexport default catalog;\n`,
  );
  projections.set(
    `packs/${target}.ts`,
    header +
      `import type {MySqlCatalogRoutineFamily} from "../../types.js";\nexport const sourceRevision=${JSON.stringify(catalog.revision)};\nconst routines=JSON.parse(${JSON.stringify(JSON.stringify(additionalRoutines))}) as readonly MySqlCatalogRoutineFamily[];\nexport default routines;\n`,
  );
  const serialized = JSON.stringify(catalog);
  if (serialized.includes("\\") || serialized.includes("`") || serialized.includes("${")) {
    throw new TypeError("MySQL catalog data cannot contain template-literal delimiters");
  }
  return `// Generated by scripts/generate-mysql-catalog.mjs. Do not edit.\nimport core from "./core/${target}.js";\nimport additional from "./packs/${target}.js";\nimport type {MySqlCoreCatalog} from "../types.js";\n\nconst catalog:MySqlCoreCatalog={...core,revision:${JSON.stringify(catalog.revision)},routines:[...core.routines,...additional].sort((a,b)=>a.name.localeCompare(b.name))};\nexport default catalog;\n`;
}

const source = JSON.parse(await readFile(sourcePath, "utf8"));
validate(source);
for (const family of selectedFamilies)
  if (!source.routines.some((entry) => entry.name === family))
    throw new TypeError(`Unknown MySQL core family ${family}`);
let stale = false;
if (!process.argv.includes("--check")) await mkdir(outputDirectory, { recursive: true });
for (const target of series) {
  const path = join(outputDirectory, `${target}.ts`);
  const rendered = render(source, target);
  if (process.argv.includes("--check")) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== rendered) stale = true;
  } else await writeFile(path, rendered, "utf8");
}
projections.set(
  "availability.ts",
  `// Generated by scripts/generate-mysql-catalog.mjs. Do not edit.\nexport const routineSeries:Readonly<Record<string,readonly string[]>>=${JSON.stringify(routineSeries)};\n`,
);
for (const [relative, output] of projections) {
  const path = join(outputDirectory, relative);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8").catch(() => "")) !== output) stale = true;
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
  }
}
if (stale) throw new Error("Generated MySQL catalogs are stale; run pnpm mysql:catalog:generate");

const codecPath = join(workspace, "packages", "mysql", "src", "codecs", "types-data.ts");
const codecSource = `// Generated by scripts/generate-mysql-catalog.mjs. Do not edit.\nimport type { MySqlCodecTypeMapping } from "./types.js";\nexport const mySqlCodecTypes: Readonly<Record<string, Readonly<Record<string, MySqlCodecTypeMapping>>>> = ${JSON.stringify(codecTypes, null, 2)};\nexport const mySqlCatalogRevisions: Readonly<Record<string, string>> = ${JSON.stringify(catalogRevisions, null, 2)};\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(codecPath, "utf8").catch(() => "")) !== codecSource)
    throw new Error("Runtime codec projection is stale");
} else await writeFile(codecPath, codecSource);
