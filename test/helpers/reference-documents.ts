export function referenceDocument(url: string) {
  const u = new URL(url),
    path = u.pathname;
  if (u.hostname === "www.postgresql.org") {
    if (path.endsWith("/functions.html"))
      return Array.from({ length: 20 }, (_, i) => `<a href="functions-fixture-${i}.html">group</a>`).join("");
    if (path.includes("/functions-fixture-")) {
      const index = Number(/fixture-(\d+)/.exec(path)![1]);
      return Array.from({ length: 6 }, (_, i) => `<code class="function">fixture_fn_${index * 6 + i}</code>`).join("");
    }
    if (path.endsWith("/datatype.html")) return '<code class="type">integer</code>';
    if (path.endsWith("/sql-keywords-appendix.html")) return '<code class="token">SELECT</code>';
    if (path.endsWith("/sql-commands.html")) return '<span class="refentrytitle"><a href="sql-select.html">SELECT</a>';
  }
  if (u.hostname === "dev.mysql.com")
    return Array.from({ length: 120 }, (_, i) => `<th scope="row"><code>FIXTURE_FN_${i}()</code></th>`).join("");
  if (u.hostname === "learn.microsoft.com")
    return JSON.stringify({
      items: [
        ...Array.from({ length: 120 }, (_, i) => ({
          toc_title: `FIXTURE_FN_${i}`,
          href: `t-sql/functions/fixture-${i}`,
        })),
        { toc_title: "integer", href: "t-sql/data-types/int" },
        { toc_title: "SELECT", href: "t-sql/statements/select" },
        { toc_title: "AND", href: "t-sql/language-elements/and" },
      ],
    });
  if (u.hostname === "www.sqlite.org") {
    if (path.endsWith("/stricttables.html"))
      return "The datatype must be one of the following:<ul><li>INT</li><li>TEXT</li></ul>";
    if (path.endsWith("/lang_keywords.html")) return "<li>SELECT</li>";
    if (path.endsWith("/lang.html")) return '<a href="lang_select.html">SELECT</a>';
    return Array.from({ length: 90 }, (_, i) => `<h2>fixture_fn_${i}(X)</h2>`).join("");
  }
  throw new Error(`Unhandled fixture URL ${url}`);
}
