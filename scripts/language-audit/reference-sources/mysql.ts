import { MYSQL_SUPPORT_POLICY } from "../../../packages/mysql/src/support.js";
import type { ReferenceSource } from "./contracts.js";
import { textContent } from "./text.js";

function extractFunctions(body: string, base: string) {
  const found: { name: string; url: string }[] = [];
  const add = (name: string, url = base) => {
    if (/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name)) found.push({ name: name.toLowerCase(), url });
  };

  for (const match of body.matchAll(/<th scope="row">([\s\S]*?)<\/th>/gu)) {
    for (const code of match[1]!.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gu)) {
      const label = textContent(code[1]!);
      if (label.endsWith("()")) add(label.slice(0, -2));
    }
  }
  return [...new Map(found.map((row) => [row.name, row])).values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const mysqlReferenceSource: ReferenceSource = {
  id: "mysql",
  referenceVersions: () => [...MYSQL_SUPPORT_POLICY.stable, MYSQL_SUPPORT_POLICY.canary].map(({ series }) => series),
  captureVersions: () => [],
  minimumFunctions: 100,
  scope: "Versioned upstream reference; documentation presence alone does not prove engine availability or semantics.",
  extractFunctions,
  async collect(version, page) {
    const functions: { name: string; url: string }[] = [];
    const extra = {};

    const url = `https://dev.mysql.com/doc/refman/${version}/en/built-in-function-reference.html`;
    functions.push(...extractFunctions(await page(url), url));
    return { functions, categories: extra };
  },
};
