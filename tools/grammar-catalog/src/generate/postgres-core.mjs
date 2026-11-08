import { createHash } from "node:crypto";
import { commonEntities } from "../model/projection.mjs";
import { postgresSemanticCasts, postgresSemanticTypes } from "./facts/postgres-semantic.mjs";

export async function generateCore({ source, ledger, semanticGroups, emit, header }) {
  const majors = [...ledger.dialects.postgres.stable, ...ledger.dialects.postgres.canary].map(
    ({ minimum, maximum }) => {
      if (minimum !== maximum) throw new Error("PostgreSQL catalog targets require an exact major");
      return Number(minimum);
    },
  );

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
      if (unknown.length > 0)
        throw new TypeError(`${collection}.${entry.name} has unknown keys: ${unknown.join(", ")}`);
      if (typeof entry.name !== "string" || identities.has(entry.name))
        throw new TypeError(`${collection} names must be unique`);
      identities.add(entry.name);
      if (!Number.isSafeInteger(entry.introduced) || entry.introduced < 1)
        throw new TypeError(`${entry.name} has invalid introduced major`);
      if (entry.removed !== undefined && (!Number.isSafeInteger(entry.removed) || entry.removed <= entry.introduced)) {
        throw new TypeError(`${entry.name} has invalid removed major`);
      }
      if (collection === "types" && (entry.category !== undefined || entry.preferred !== undefined))
        throw new TypeError(`${entry.name} type categories and preferences must come from native facts`);
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
    }
  }

  function build(source, major) {
    const semantic = semanticGroups.find((group) => Number(group.band) === major);
    if (!semantic) throw new Error(`Missing PostgreSQL semantic profile: ${major}`);
    const types = postgresSemanticTypes(
      commonEntities(semantic, "types"),
      source.types.filter((entry) => active(entry, major)).map(stripVersion),
      source.typeCategories,
    );
    const casts = postgresSemanticCasts(commonEntities(semantic, "casts"), types);
    validateCasts(casts, source.types);
    const selected = stable({
      formatVersion: 1,
      major,
      types: types.sort((left, right) => left.name.localeCompare(right.name)),
      casts,
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
    return catalog;
  }

  if (source.formatVersion !== 1) throw new TypeError("Unsupported PostgreSQL catalog source format");
  validateEntries(source.types, "types", "aliases");
  if (source.casts !== "native-catalog")
    throw new TypeError("PostgreSQL casts must come from the reviewed native catalog");
  validateEntries(source.operators, "operators", "operators");
  validateEntries(source.routines, "routines", "routines");
  validateEntries(source.tableRoutines, "tableRoutines", "routines");

  const profiles = new Map();
  const codecMajors = [],
    revisions = {};
  for (const major of majors) {
    const catalog = build(source, major);
    await emit(
      `packages/postgres/src/catalog/generated/${major}.ts`,
      `${header}import type { PostgresCoreCatalog } from "../types.js";\n\nconst catalog: PostgresCoreCatalog = ${JSON.stringify(catalog, null, 2)};\nexport default Object.freeze(catalog);\n`,
    );
    const mapping = Object.fromEntries(
      catalog.types.flatMap((type) => [type.name, ...type.aliases].map((name) => [name, type.mapping])),
    );
    const identity = JSON.stringify(stable(mapping));
    if (!profiles.has(identity)) profiles.set(identity, `types${major}`);
    codecMajors.push(`${JSON.stringify(major)}:${profiles.get(identity)}`);
    revisions[major] = catalog.revision;
  }
  await emit(
    "packages/postgres/src/codecs/generated/types.ts",
    `${header}import type { PostgresCodecTypeMapping } from "../types.js";\n${[...profiles].map(([mapping, name]) => `const ${name}: Readonly<Record<string,PostgresCodecTypeMapping>> = Object.freeze(Object.fromEntries<PostgresCodecTypeMapping>(${JSON.stringify(Object.entries(JSON.parse(mapping)))}));`).join("\n")}\nexport const postgresCodecTypes: Readonly<Record<number,Readonly<Record<string,PostgresCodecTypeMapping>>>> = Object.freeze({${codecMajors.join(",")}});\nexport const postgresCatalogRevisions: Readonly<Record<number,string>> = Object.freeze(${JSON.stringify(revisions)});\n`,
  );
  const registry = `${header}${majors.map((major) => `import catalog${major} from "./${major}.js";`).join("\n")}\nexport const postgresCatalogs = [${majors.map((major) => `catalog${major}`).join(", ")}] as const;\n`;
  await emit("packages/postgres/src/catalog/generated/registry.ts", registry);
}
