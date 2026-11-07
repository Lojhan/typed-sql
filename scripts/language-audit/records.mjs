import { canonical, hash } from "./hash.mjs";

export { hash } from "./hash.mjs";
export const CATEGORIES = Object.freeze([
  "functions",
  "keywords",
  "types",
  "operators",
  "casts",
  "collations",
  "settings",
  "extensions",
  "syntax",
]);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// One signature/observation per line keeps generated evidence reviewable.
export function serialize(value, indent = 0) {
  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const flat = (item) =>
      item === null ||
      typeof item !== "object" ||
      typeof item.sql === "string" ||
      Boolean(item.signature) ||
      (Array.isArray(item)
        ? item.every((entry) => entry === null || typeof entry !== "object")
        : Object.values(item).every(
            (entry) =>
              entry === null ||
              typeof entry !== "object" ||
              (Array.isArray(entry) && entry.every((child) => child === null || typeof child !== "object")),
          ));
    return `[\n${value.map((item) => `${padding}  ${flat(item) ? JSON.stringify(item) : serialize(item, indent + 2)}`).join(",\n")}\n${padding}]`;
  }
  if (value && typeof value === "object") {
    if (typeof value.sql === "string" || value.signature) return JSON.stringify(value);
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([key, item]) => `${padding}  ${JSON.stringify(key)}: ${serialize(item, indent + 2)}`).join(",\n")}\n${padding}}`;
  }
  return JSON.stringify(value);
}

export function inventory(rows, source, scope = "engine") {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`Empty inventory: ${source}`);
  const values = [
    ...new Map(
      rows.map((row) => {
        if (typeof row.name !== "string" || !row.name.trim()) throw new Error(`Missing inventory name: ${source}`);
        const normalized = canonical(row);
        return [JSON.stringify(normalized), normalized];
      }),
    ).values(),
  ].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { status: "observed", scope, source, fingerprint: hash(values), rows: values };
}

export const unavailable = (reason) => ({ status: "unavailable", reason });
