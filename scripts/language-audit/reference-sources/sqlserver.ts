import { SQLSERVER_LANGUAGE_SUPPORT } from "../../../packages/sqlserver/src/support.js";
import { inventory } from "../records.mjs";
import type { ReferenceSource } from "./contracts.js";

export function extractMicrosoftToc(body: string, major: number) {
  const moniker = major === 14 ? "sql-server-2017" : `sql-server-ver${major}`;
  const rows: { name: string; url: string }[] = [];
  function walk(items: { href?: string; toc_title?: string; monikers?: string[]; children?: typeof items }[]) {
    for (const item of items) {
      if (item.monikers && !item.monikers.includes(moniker)) continue;
      if (item.href?.startsWith("t-sql/functions/")) {
        for (const name of (item.toc_title ?? "").split(/\s+and\s+|,\s*/u)) {
          if (/^(?:@@)?[A-Z_][A-Z_0-9]*$/u.test(name))
            rows.push({
              name: name.toLowerCase(),
              url: `https://learn.microsoft.com/en-us/sql/${item.href}?view=${moniker}`,
            });
        }
      }
      if (item.children) walk(item.children);
    }
  }
  walk(JSON.parse(body).items);
  return rows;
}

export const sqlserverReferenceSource: ReferenceSource = {
  id: "sqlserver",
  referenceVersions: () => SQLSERVER_LANGUAGE_SUPPORT.engineMajors.map(String),
  captureVersions: () => [],
  minimumFunctions: 100,
  scope: "Versioned upstream reference; documentation presence alone does not prove engine availability or semantics.",
  async collect(version, page) {
    const functions: { name: string; url: string }[] = [];
    const extra: Record<string, ReturnType<typeof inventory>> = {};

    const url = `https://learn.microsoft.com/en-us/sql/toc.json?view=${version === "14" ? "sql-server-2017" : `sql-server-ver${version}`}`;
    const body = await page(url);
    functions.push(...extractMicrosoftToc(body, Number(version)));
    const moniker = version === "14" ? "sql-server-2017" : `sql-server-ver${version}`;
    const entries: { name: string; url: string; category: string }[] = [];
    function walk(items: { href?: string; toc_title?: string; monikers?: string[]; children?: typeof items }[]) {
      for (const item of items) {
        if (item.monikers && !item.monikers.includes(moniker)) continue;
        for (const [category, prefix] of [
          ["types", "t-sql/data-types/"],
          ["syntax", "t-sql/statements/"],
          ["operators", "t-sql/language-elements/"],
        ]) {
          if (item.href?.startsWith(prefix!) && item.toc_title)
            entries.push({
              name: item.toc_title,
              url: `https://learn.microsoft.com/en-us/sql/${item.href}?view=${moniker}`,
              category: category!,
            });
        }
        if (item.children) walk(item.children);
      }
    }
    walk(JSON.parse(body).items);
    for (const category of ["types", "syntax", "operators"])
      extra[category] = inventory(
        entries.filter((row) => row.category === category).map(({ name, url }) => ({ name, url })),
        url,
        "reference-navigation; language-elements include more than operators",
      );
    return { functions, categories: extra };
  },
};
