import { POSTGRES_SUPPORT_POLICY } from "../../../packages/postgres/src/support.js";
import { inventory } from "../records.mjs";
import type { ReferenceSource } from "./contracts.js";
import { textContent } from "./text.js";

function extractFunctions(body: string, base: string) {
  const found: { name: string; url: string }[] = [];
  const add = (name: string, url = base) => {
    if (/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name)) found.push({ name: name.toLowerCase(), url });
  };

  for (const match of body.matchAll(/<code class="function">([\s\S]*?)<\/code>/gu)) add(textContent(match[1]!));
  return [...new Map(found.map((row) => [row.name, row])).values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const postgresReferenceSource: ReferenceSource = {
  id: "postgres",
  referenceVersions: () => [...POSTGRES_SUPPORT_POLICY.stableMajors, POSTGRES_SUPPORT_POLICY.canary.major].map(String),
  captureVersions: () => [],
  minimumFunctions: 100,
  scope: "Versioned upstream reference; documentation presence alone does not prove engine availability or semantics.",
  extractFunctions,
  async collect(version, page) {
    const functions: { name: string; url: string }[] = [];
    const extra: Record<string, ReturnType<typeof inventory>> = {};

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
        pages.slice(start, start + 6).map(async (url) => extractFunctions(await page(url), url)),
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
    return { functions, categories: extra };
  },
};
