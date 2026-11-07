import { SQLITE_LANGUAGE_SUPPORT } from "../../../packages/sqlite/src/support.js";
import { inventory } from "../records.mjs";
import type { ReferenceSource } from "./contracts.js";
import { textContent } from "./text.js";

export function extractSqliteStrictTypes(body: string, url: string) {
  const list = /The datatype must be one of the following:[\s\S]*?<ul>([\s\S]*?)<\/ul>/u.exec(body)?.[1];
  if (!list) throw new Error("SQLite STRICT type inventory not found");
  const rows = [...list.matchAll(/<li>\s*([A-Z][A-Z_0-9]*)\s*<\/li>/gu)].map((match) => ({ name: match[1]!, url }));
  if (!rows.length) throw new Error("Empty SQLite STRICT type inventory");
  return rows;
}

function extractFunctions(body: string, base: string) {
  const found: { name: string; url: string }[] = [];
  const add = (name: string, url = base) => {
    if (/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name)) found.push({ name: name.toLowerCase(), url });
  };

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
  return [...new Map(found.map((row) => [row.name, row])).values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const sqliteReferenceSource: ReferenceSource = {
  id: "sqlite",
  referenceVersions: () => [`reference-${SQLITE_LANGUAGE_SUPPORT.maximum}`],
  captureVersions: () => ["live"],
  minimumFunctions: 70,
  scope: "Unversioned upstream reference; availability must be checked against each live SQLite build.",
  extractFunctions,
  async collect(_version, page) {
    const functions: { name: string; url: string }[] = [];
    const extra: Record<string, ReturnType<typeof inventory>> = {};

    const strictUrl = "https://www.sqlite.org/stricttables.html";
    extra.types = inventory(
      extractSqliteStrictTypes(await page(strictUrl), strictUrl),
      strictUrl,
      "STRICT-declared-type-names; ordinary SQLite types remain open-ended affinity declarations",
    );
    for (const path of [
      "lang_corefunc.html",
      "lang_aggfunc.html",
      "windowfunctions.html",
      "lang_datefunc.html",
      "lang_mathfunc.html",
      "json1.html",
    ]) {
      const url = `https://www.sqlite.org/${path}`;
      functions.push(...extractFunctions(await page(url), url));
    }
    const url = "https://www.sqlite.org/lang_keywords.html";
    extra.keywords = inventory(
      [...(await page(url)).matchAll(/<li>([A-Z_]+)<\/li>/gu)].map((match) => ({ name: match[1]!, url })),
      url,
      "documented-keywords",
    );
    const syntaxUrl = "https://www.sqlite.org/lang.html";
    extra.syntax = inventory(
      [...(await page(syntaxUrl)).matchAll(/<a href=['"](lang_[^'"#]+\.html)['"]>([\s\S]*?)<\/a>/gu)].map((match) => ({
        name: textContent(match[2]!),
        url: new URL(match[1]!, syntaxUrl).href,
      })),
      syntaxUrl,
      "documented-statements",
    );
    return { functions, categories: extra };
  },
};
