import type { PlaygroundDialect } from "./dialect-browser-runtime.js";
import type { WorkspaceFiles } from "./workspace.js";

/** The same commerce queries demonstrate bindings and application identities in every grammar. */
export function featureExampleFiles(dialect: PlaygroundDialect, lesson: "bindings" | "brands", schema: string) {
  const branded = lesson === "brands";
  const indexed = dialect === "postgres" || dialect === "duckdb";
  const named = dialect === "sqlserver" ? "@userId" : dialect === "duckdb" ? "$userId" : ":userId";
  const positional = indexed ? "email <> $2 AND (id = $1 OR id = $1)" : "email <> ? AND id = ?";
  const files = {
    "schema/tables.sql": schema,
    "queries/account.ts": `import { sql } from "@typed-sql/${dialect}";
${branded ? 'import type { Brand } from "@typed-sql/core";\n' : ""}
export const accountById = (id: ${branded ? 'Brand<bigint, "UserId">' : "bigint"}) => sql\`
  SELECT id, email FROM users WHERE id = \${id}
\`;
`,
    "queries/orders.sql": `-- name: ordersByCustomer
SELECT id, user_id, status FROM orders
WHERE user_id = ${named} OR user_id = ${named};
`,
    "queries/account-positional.sql": `-- name: accountByPosition
SELECT id, email FROM users WHERE ${positional};
`,
    "app.ts": `import ordersByCustomer from "./queries/orders.sql";
import accountByPosition from "./queries/account-positional.sql";
import { accountById } from "./queries/account.ts";
import { ${branded ? "brandValue, " : ""}type QueryRow, type QueryParameters, type Database } from "@typed-sql/core";

${branded ? '// Establish identities only after validating external input.\nconst userId = brandValue(42n, "UserId");\nconst orderId = brandValue(9001n, "OrderId");' : "const userId = 42n;"}

// Hover the imported factory: one object property binds both SQL occurrences.
const orders = ordersByCustomer({ userId });
const account = accountById(userId);
${indexed ? "// Numeric argument order stays [id, email] despite $2 appearing first." : "// Question-mark arguments follow their occurrence order in SQL."}
const positional = accountByPosition(${indexed ? 'userId, "excluded@example.com"' : '"excluded@example.com", userId'});

type Order = QueryRow<typeof orders>;
type BoundOccurrences = QueryParameters<typeof orders>;

// ${branded ? "Try ordersByCustomer({ userId: orderId }) to see the brand mismatch." : 'Try ordersByCustomer({ userId: "42" }) to see the type error.'}
// ${branded ? "Edit schema/brands.ts to change the shared column identities." : "A PostgreSQL numeric gap or mixed named/positional binding is a SQL diagnostic."}
declare const database: Database;
const rows = await database.all(orders);

// Outside the browser: typed-sql manifest includes this imported SQL.
// verify --live, explain and compat consume that manifest; see the SQL-file guide.
// The playground checks types and diagnostics; it does not run those commands or SQL.
`,
  } satisfies WorkspaceFiles;
  return {
    ...files,
    ...(branded
      ? {
          "schema/brands.ts": `// The playground reads this literal object without executing configuration.
// In an application, pass it to withSchemaBrands(await provider.introspect(), brands).
export const brands = {
  columns: {
    users: { id: "UserId" },
    orders: { id: "OrderId", user_id: "UserId" },
  },
} as const;
`,
        }
      : {}),
  };
}
