import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DUCKDB_SUPPORT_POLICY } from "../../packages/duckdb/src/support.js";
import { MYSQL_SUPPORT_POLICY } from "../../packages/mysql/src/support.js";
import { POSTGRES_SUPPORT_POLICY } from "../../packages/postgres/src/support.js";
import { SQLITE_LANGUAGE_SUPPORT } from "../../packages/sqlite/src/support.js";
import { SQLSERVER_LANGUAGE_SUPPORT } from "../../packages/sqlserver/src/support.js";
import { hash, inventory, serialize } from "./inventory.mjs";

export const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/language-audit");
export const textContent = (html: string): string =>
  html
    .replace(/<[^>]*>/gu, "")
    .replace(/&(?:nbsp|#160);/gu, " ")
    .replace(/&amp;/gu, "&")
    .trim();

export function extractFunctions(dialect: string, body: string, base: string): { name: string; url: string }[] {
  const found: { name: string; url: string }[] = [];
  const add = (name: string, url = base) => {
    if (/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name)) found.push({ name: name.toLowerCase(), url });
  };
  if (dialect === "postgres") {
    for (const match of body.matchAll(/<code class="function">([\s\S]*?)<\/code>/gu)) add(textContent(match[1]!));
  } else if (dialect === "mysql") {
    for (const match of body.matchAll(/<th scope="row">([\s\S]*?)<\/th>/gu)) {
      for (const code of match[1]!.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gu)) {
        const label = textContent(code[1]!);
        if (label.endsWith("()")) add(label.slice(0, -2));
      }
    }
  } else if (dialect === "sqlite") {
    for (const match of body.matchAll(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gu)) {
      if (new URL(match[1]!, base).pathname !== new URL(base).pathname) continue;
      const label = textContent(match[2]!).replace(/^\d+(?:\.\d+)*\.\s*(?:The\s+)?/u, "");
      const name = /^([a-z_][a-z_0-9]*)\s*\(/iu.exec(label)?.[1];
      if (name) add(name, new URL(match[1]!, base).href);
    }
    // JSON, date/time, math and window reference pages also declare signatures in headings.
    for (const match of body.matchAll(/(?:<dt>\s*<p>\s*<b>|<h[1-6]\b[^>]*>)([\s\S]*?)<\/(?:b|h[1-6])>/gu)) {
      const name = /^(?:\d+(?:\.\d+)*\.\s*)?(?:The\s+)?([a-z_][a-z_0-9]*)\s*\(/iu.exec(textContent(match[1]!))?.[1];
      if (name) add(name);
    }
    for (const match of body.matchAll(/<a\b[^>]*href=['"](#[^'"]+)['"][^>]*>([a-z_][a-z_0-9]*)<\/a>\s*\(/giu))
      add(match[2]!, new URL(match[1]!, base).href);
  } else throw new Error(`No extractor for ${dialect}`);
  return [...new Map(found.map((row) => [row.name, row])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

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

export function referenceTargets() {
  return [
    ...[...POSTGRES_SUPPORT_POLICY.stableMajors, POSTGRES_SUPPORT_POLICY.canary.major].map((version) => ({
      dialect: "postgres",
      version: String(version),
    })),
    ...[...MYSQL_SUPPORT_POLICY.stable, MYSQL_SUPPORT_POLICY.canary].map(({ series }) => ({
      dialect: "mysql",
      version: series,
    })),
    { dialect: "sqlite", version: `reference-${SQLITE_LANGUAGE_SUPPORT.maximum}` },
    ...SQLSERVER_LANGUAGE_SUPPORT.engineMajors.map((version) => ({ dialect: "sqlserver", version: String(version) })),
  ];
}

export async function refreshReferences() {
  await mkdir(directory, { recursive: true });
  const cache = new Map<string, Promise<string>>();
  function download(url: string) {
    let result = cache.get(url);
    if (!result) {
      result = (async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`${response.status}: ${url}`);
        // Redirecting an unavailable version to a different manual is not evidence for that version.
        if (response.url !== url) throw new Error(`Unexpected upstream redirect: ${url} -> ${response.url}`);
        return response.text();
      })();
      cache.set(url, result);
    }
    return result;
  }
  for (const { dialect, version } of referenceTargets()) {
    const sources: { url: string; hash: string }[] = [];
    const functions: { name: string; url: string }[] = [];
    const extra: Record<string, ReturnType<typeof inventory>> = {};
    async function page(url: string) {
      const body = await download(url);
      sources.push({ url, hash: hash(body) });
      return body;
    }
    if (dialect === "postgres") {
      const base = `https://www.postgresql.org/docs/${version}/functions.html`;
      const body = await page(base);
      const pages = [
        ...new Set(
          [...body.matchAll(/href="(functions-[a-z0-9-]+\.html)(?:#[^"]*)?"/gu)].map(
            (match) => new URL(match[1]!, base).href,
          ),
        ),
      ].sort();
      if (pages.length < 20) throw new Error(`PostgreSQL ${version}: incomplete chapter index`);
      // Bound upstream concurrency; all failures propagate.
      for (let start = 0; start < pages.length; start += 6) {
        const batch = await Promise.all(
          pages.slice(start, start + 6).map(async (url) => extractFunctions(dialect, await page(url), url)),
        );
        functions.push(...batch.flat());
      }
      for (const [category, path, className] of [
        ["types", "datatype.html", "type"],
        ["keywords", "sql-keywords-appendix.html", "token"],
      ]) {
        const url = new URL(path!, base).href;
        const content = await page(url);
        const rows = [...content.matchAll(new RegExp(`<code class="${className}">([\\s\\S]*?)<\\/code>`, "gu"))].map(
          (match) => ({ name: textContent(match[1]!), url }),
        );
        extra[category!] = inventory(
          rows,
          url,
          "reference-tokens; PostgreSQL keyword appendix includes SQL-standard-only words",
        );
      }
      const url = new URL("sql-commands.html", base).href;
      extra.syntax = inventory(
        [...(await page(url)).matchAll(/<span class="refentrytitle"><a href="([^"]+)">([\s\S]*?)<\/a>/gu)].map(
          (match) => ({ name: textContent(match[2]!), url: new URL(match[1]!, url).href }),
        ),
        url,
        "documented-statements",
      );
    } else if (dialect === "mysql") {
      const url = `https://dev.mysql.com/doc/refman/${version}/en/built-in-function-reference.html`;
      functions.push(...extractFunctions(dialect, await page(url), url));
    } else if (dialect === "sqlserver") {
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
    } else {
      for (const path of [
        "lang_corefunc.html",
        "lang_aggfunc.html",
        "windowfunctions.html",
        "lang_datefunc.html",
        "lang_mathfunc.html",
        "json1.html",
      ]) {
        const url = `https://www.sqlite.org/${path}`;
        functions.push(...extractFunctions(dialect, await page(url), url));
      }
      const url = "https://www.sqlite.org/lang_keywords.html";
      extra.keywords = inventory(
        [...(await page(url)).matchAll(/<li>([A-Z_]+)<\/li>/gu)].map((match) => ({ name: match[1]!, url })),
        url,
        "documented-keywords",
      );
      const syntaxUrl = "https://www.sqlite.org/lang.html";
      extra.syntax = inventory(
        [...(await page(syntaxUrl)).matchAll(/<a href=['"](lang_[^'"#]+\.html)['"]>([\s\S]*?)<\/a>/gu)].map(
          (match) => ({ name: textContent(match[2]!), url: new URL(match[1]!, syntaxUrl).href }),
        ),
        syntaxUrl,
        "documented-statements",
      );
    }
    const distinct = [...new Map(functions.map((row) => [row.name, row])).values()];
    if (distinct.length < (dialect === "sqlite" ? 70 : 100))
      throw new Error(`Suspiciously small ${dialect} inventory: ${distinct.length}`);
    const result = {
      formatVersion: 1,
      dialect,
      target: { version },
      scope:
        dialect === "sqlite"
          ? "Unversioned upstream reference; availability must be checked against each live SQLite build."
          : "Versioned upstream reference; documentation presence alone does not prove engine availability or semantics.",
      sources: sources.sort((a, b) => a.url.localeCompare(b.url)),
      categories: { functions: inventory(distinct, "official-reference", "documented-functions"), ...extra },
    };
    await writeFile(resolve(directory, `${dialect}-${version}.json`), `${serialize(result)}\n`);
    console.log(`${dialect} ${version}: ${distinct.length} documented function names`);
  }
}

export async function loadReferences() {
  return Promise.all(
    [
      ...referenceTargets(),
      ...liveDuckDBTargets.map((version) => ({ dialect: "duckdb", version })),
      { dialect: "sqlite", version: "live" },
    ].map(async ({ dialect, version }) =>
      JSON.parse(await readFile(resolve(directory, `${dialect}-${version}.json`), "utf8")),
    ),
  );
}

export const liveDuckDBTargets = DUCKDB_SUPPORT_POLICY.qualifiedEngines;
