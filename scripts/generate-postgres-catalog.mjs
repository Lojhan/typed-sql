import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(workspace, "grammar", "postgres", "catalog", "core.json");
const outputDirectory = join(workspace, "packages", "postgres", "src", "catalog", "generated");
const majors = [14, 15, 16, 17, 18, 19];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function active(entry, major) {
  return entry.introduced <= major && (entry.removed === undefined || major < entry.removed);
}

function stripVersion(entry) {
  const { introduced: _introduced, removed: _removed, ...catalogEntry } = entry;
  return catalogEntry;
}

function validateEntries(entries, collection, names) {
  if (!Array.isArray(entries)) throw new TypeError(`${collection} must be an array`);
  const identities = new Set();
  const members = new Set();
  for (const entry of entries) {
    const allowed = new Set([
      "name",
      names,
      "result",
      "mapping",
      "aliases",
      "category",
      "preferred",
      "introduced",
      "removed",
    ]);
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new TypeError(`${collection}.${entry.name} has unknown keys: ${unknown.join(", ")}`);
    if (typeof entry.name !== "string" || identities.has(entry.name))
      throw new TypeError(`${collection} names must be unique`);
    identities.add(entry.name);
    if (!Number.isSafeInteger(entry.introduced) || entry.introduced < 1)
      throw new TypeError(`${entry.name} has invalid introduced major`);
    if (entry.removed !== undefined && (!Number.isSafeInteger(entry.removed) || entry.removed <= entry.introduced)) {
      throw new TypeError(`${entry.name} has invalid removed major`);
    }
    if (collection === "types") {
      if (
        ![
          "array",
          "bit-string",
          "boolean",
          "composite",
          "datetime",
          "enum",
          "geometric",
          "network",
          "numeric",
          "range",
          "string",
          "timespan",
          "user",
        ].includes(entry.category)
      )
        throw new TypeError(`${entry.name} has invalid type category`);
      if (typeof entry.preferred !== "boolean") throw new TypeError(`${entry.name} has invalid preferred flag`);
    }
    const declaredMembers = names === "aliases" ? [entry.name, ...(entry.aliases ?? [])] : entry[names];
    if (!Array.isArray(declaredMembers)) throw new TypeError(`${collection}.${entry.name}.${names} must be an array`);
    for (const member of declaredMembers) {
      if (members.has(member)) throw new TypeError(`${collection} member ${member} is duplicated`);
      members.add(member);
    }
  }
}

function validateCasts(entries, types) {
  if (!Array.isArray(entries)) throw new TypeError("casts must be an array");
  const identities = new Set();
  const typeNames = new Set(types.map(({ name }) => name));
  for (const entry of entries) {
    const allowed = new Set(["source", "target", "context", "method", "introduced", "removed"]);
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    const identity = `${entry.source}>${entry.target}`;
    if (unknown.length > 0) throw new TypeError(`casts.${identity} has unknown keys: ${unknown.join(", ")}`);
    if (typeof entry.source !== "string" || typeof entry.target !== "string" || identities.has(identity))
      throw new TypeError("cast source/target pairs must be unique strings");
    if (!typeNames.has(entry.source) || !typeNames.has(entry.target))
      throw new TypeError(`${identity} references an unknown canonical type`);
    identities.add(identity);
    if (!["explicit", "assignment", "implicit"].includes(entry.context))
      throw new TypeError(`${identity} has invalid cast context`);
    if (!["binary", "function", "io"].includes(entry.method))
      throw new TypeError(`${identity} has invalid cast method`);
    if (!Number.isSafeInteger(entry.introduced) || entry.introduced < 1)
      throw new TypeError(`${identity} has invalid introduced major`);
    if (entry.removed !== undefined && (!Number.isSafeInteger(entry.removed) || entry.removed <= entry.introduced))
      throw new TypeError(`${identity} has invalid removed major`);
  }
}

function render(source, major) {
  const selected = stable({
    formatVersion: 1,
    major,
    types: source.types
      .filter((entry) => active(entry, major))
      .map((entry) => ({ ...stripVersion(entry), aliases: [...entry.aliases].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    casts: source.casts
      .filter((entry) => active(entry, major))
      .map(stripVersion)
      .sort((left, right) => `${left.source}>${left.target}`.localeCompare(`${right.source}>${right.target}`)),
    operators: source.operators
      .filter((entry) => active(entry, major))
      .map((entry) => ({ ...stripVersion(entry), operators: [...entry.operators].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    routines: source.routines
      .filter((entry) => active(entry, major))
      .map((entry) => ({ ...stripVersion(entry), routines: [...entry.routines].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    tableRoutines: source.tableRoutines
      .filter((entry) => active(entry, major))
      .map((entry) => ({ ...stripVersion(entry), routines: [...entry.routines].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
  const canonical = JSON.stringify(selected);
  const catalog = { ...selected, revision: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  return `// Generated by scripts/generate-postgres-catalog.mjs. Do not edit.\nimport type { PostgresCoreCatalog } from "../types.js";\n\nexport default Object.freeze(${JSON.stringify(catalog, null, 2)}) as unknown as PostgresCoreCatalog;\n`;
}

const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (source.formatVersion !== 1) throw new TypeError("Unsupported PostgreSQL catalog source format");
validateEntries(source.types, "types", "aliases");
validateCasts(source.casts, source.types);
validateEntries(source.operators, "operators", "operators");
validateEntries(source.routines, "routines", "routines");
validateEntries(source.tableRoutines, "tableRoutines", "routines");

let stale = false;
if (!process.argv.includes("--check")) await mkdir(outputDirectory, { recursive: true });
for (const major of majors) {
  const path = join(outputDirectory, `${major}.ts`);
  const rendered = render(source, major);
  if (process.argv.includes("--check")) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== rendered) stale = true;
  } else {
    await writeFile(path, rendered, "utf8");
  }
}
if (stale) throw new Error("Generated PostgreSQL catalogs are stale; run pnpm postgres:catalog:generate");
