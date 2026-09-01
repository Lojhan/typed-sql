# @typed-sql/ast

The grammar-neutral, bounded tokenizer toolkit, token cursor, tree walker, and source-range package used by
[typed-sql](https://github.com/Lojhan/typed-sql).

This is a stable package. The toolkit subpath is its forward-looking parser-construction API.

```sh
pnpm add @typed-sql/ast
```

```ts
import {
  defineSqlLexicalProfile,
  TokenCursor,
  tokenizeSql,
} from "@typed-sql/ast/toolkit";

const profile = defineSqlLexicalProfile({
  keywords: new Set(["FROM", "SELECT"]),
  operators: ["="],
  identifierQuotes: [{ open: '"', close: '"', escape: "double-close" }],
  stringModes: [{ prefix: "", quote: "'" }],
  parameterModes: [{ kind: "numbered-dollar", startAt: 1 }],
});
const cursor = new TokenCursor(tokenizeSql("SELECT id FROM account", profile));
cursor.expect("SELECT");
```

Grammar packages own keywords, operators, quoting, ASTs, productions, and syntax diagnostics. The toolkit preserves
ranges and enforces SQL-length, token-count, and nesting limits without embedding a database grammar.

The package-root multi-dialect parser remains as a deprecated typed-sql 2.x compatibility entrypoint. First-party
grammars do not depend on it, and typed-sql 3.0 removes that compatibility parser. New integrations must use a
grammar package for complete SQL analysis or `@typed-sql/ast/toolkit` to build a grammar-owned parser.

Application code normally imports `sql` from its selected dialect package instead.
See [Inference and safety](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/type-safety.md),
the [custom grammar guide](https://github.com/Lojhan/typed-sql/blob/main/docs/extending/custom-grammars.md),
and the [diagnostic reference](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/diagnostics.md).

MIT © typed-sql contributors
