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

export { serialize } from "../../tools/grammar-catalog/src/model/serialize.mjs";

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
