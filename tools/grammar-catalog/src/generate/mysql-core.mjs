import { createHash } from "node:crypto";

export async function generateCore({ source, ledger, emit, header }) {
  const series = [...ledger.dialects.mysql.stable, ...ledger.dialects.mysql.canary].map(({ minimum, maximum }) => {
    if (minimum !== maximum) throw new Error("MySQL catalog targets require an exact series");
    return minimum;
  });
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
        memberKey === "name"
          ? [entry.name]
          : memberKey === "aliases"
            ? [entry.name, ...entry.aliases]
            : entry[memberKey];
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
    const serialized = JSON.stringify(catalog);
    return `${header}import type { MySqlCoreCatalog } from "../types.js";\n\nconst catalog: MySqlCoreCatalog = ${serialized};\n\nexport default catalog;\n`;
  }

  validate(source);
  for (const target of series) await emit(`packages/mysql/src/catalog/generated/${target}.ts`, render(source, target));
  const registry = `${header}${series.map((target, index) => `import catalog${index} from "./${target}.js";`).join("\n")}\nexport const mySqlCatalogs = [${series.map((_target, index) => `catalog${index}`).join(", ")}] as const;\n`;
  await emit("packages/mysql/src/catalog/generated/registry.ts", registry);
}
