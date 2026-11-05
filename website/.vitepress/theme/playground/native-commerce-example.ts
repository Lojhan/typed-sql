import { COMMERCE_SCHEMAS } from "../../../../examples/shared/commerce-schema.js";
import { ENVIRONMENT_FILE, environmentSource } from "./environment-model.js";
import type { WorkspaceFiles } from "./workspace.js";

/** Native SQL for the two new grammars; no PostgreSQL syntax substitution or fallback analysis. */
export function nativeCommerceFiles(dialect: "sqlserver" | "duckdb") {
  const sqlserver = dialect === "sqlserver";
  const databaseType = sqlserver ? "SqlServerDatabase" : "DuckDBDatabase";
  const temporal = sqlserver ? "datetime2(7)" : "TIMESTAMPTZ";
  const output = sqlserver ? "OUTPUT inserted.id, inserted.sku, inserted.price_cents" : "";
  const returning = sqlserver ? "" : "RETURNING id, sku, price_cents";
  const files: WorkspaceFiles = {
    "schema/tables.sql": COMMERCE_SCHEMAS[dialect],
    [ENVIRONMENT_FILE]: environmentSource(
      sqlserver ? { version: "17.0.5035.5", settings: { compatibilityLevel: 170 } } : { version: "2.0.0" },
    ),
    "queries/account.ts": `import { sql } from "@typed-sql/${dialect}";

export const accountById = (id: bigint) => sql\`
  SELECT u.id, u.email, u.display_name, u.status, u.created_at,
         t.name AS team_name, m.role
  FROM users AS u
  LEFT JOIN memberships AS m ON m.user_id = u.id
  LEFT JOIN teams AS t ON t.id = m.team_id
  WHERE u.id = \${id}
\`;
`,
    "queries/revenue.sql": `-- name: revenueByCustomer
WITH paid_orders AS (
  SELECT user_id, COUNT(*) AS order_count, SUM(total_cents) AS revenue_cents
  FROM orders WHERE status = 'paid' GROUP BY user_id
)
SELECT u.id, LOWER(u.email) AS email, p.order_count, p.revenue_cents
FROM users AS u JOIN paid_orders AS p ON p.user_id = u.id
WHERE p.revenue_cents >= ${sqlserver ? "@minimumRevenue" : "$1"}
ORDER BY p.revenue_cents DESC;
`,
    "queries/order-json.ts": `import { sql } from "@typed-sql/${dialect}";

${sqlserver ? "// Stored JSON stays text; its internal shape is not guessed from its column name." : "// Native STRUCT construction proves each field; this value is not serialized JSON."}
export const orderDocument = (orderId: bigint) => sql\`
  SELECT o.id, ${sqlserver ? "JSON_QUERY(u.profile)" : "struct_pack(id := o.id, status := o.status, totalCents := o.total_cents, customer := struct_pack(email := u.email))"} AS document
  FROM orders AS o JOIN users AS u ON u.id = o.user_id
  WHERE o.id = \${orderId}
\`;
`,
    "queries/insert-products.ts": `import { sql } from "@typed-sql/${dialect}";

export interface NewProduct { readonly id: bigint; readonly sku: string; readonly title: string; readonly priceCents: number; }
export function insertProducts(items: readonly NewProduct[]) {
  if (!items.length) throw new RangeError("At least one product is required");
  return sql\`
    INSERT INTO products (id, sku, title, price_cents, active)
    ${output}
    VALUES \${items.map(item => sql.fragment\`(\${item.id}, \${item.sku}, \${item.title}, \${item.priceCents}, \${true})\`)}
    ${returning}
  \`;
}
`,
    "queries/insert-pair.ts": `import { sql } from "@typed-sql/${dialect}";
import type { NewProduct } from "./insert-products.ts";
export const insertPair = (first: NewProduct, second: NewProduct) => sql\`
  INSERT INTO products (id, sku, title, price_cents, active)
  ${output}
  VALUES (\${first.id}, \${first.sku}, \${first.title}, \${first.priceCents}, \${true}),
         (\${second.id}, \${second.sku}, \${second.title}, \${second.priceCents}, \${true})
  ${returning}
\`;
`,
    "queries/audit.ts": `import { sql } from "@typed-sql/${dialect}";
export interface AuditPayload { readonly source: string; readonly productIds: readonly number[]; readonly approved: boolean; }
// The native ${sqlserver ? "NVARCHAR" : "JSON"} policy accepts text, with an exact temporal string target.
export const recordAudit = (id: bigint, userId: bigint, payload: AuditPayload, createdAt: string) => sql\`
  INSERT INTO audit_events (id, user_id, event_name, payload, created_at)
  ${sqlserver ? "OUTPUT inserted.id, inserted.event_name" : ""}
  VALUES (\${id}, \${userId}, 'catalog.imported', \${JSON.stringify(payload)}, CAST(\${createdAt} AS ${temporal}))
  ${sqlserver ? "" : "RETURNING id, event_name"}
\`;
`,
    "queries/catalog.ts": `import { sql } from "@typed-sql/${dialect}";
export const catalog = (minimumPrice: number) => sql\`
  SELECT id, sku, title, price_cents FROM products
  WHERE active = \${true} AND price_cents >= \${minimumPrice}
  ORDER BY price_cents DESC
\`;
export const markShipped = (orderId: bigint, shippedAt: string) => sql\`
  UPDATE orders SET status = 'shipped', shipped_at = CAST(\${shippedAt} AS ${temporal})
  ${sqlserver ? "OUTPUT inserted.id, inserted.status, inserted.shipped_at" : ""}
  WHERE id = \${orderId} AND status = 'paid'
  ${sqlserver ? "" : "RETURNING id, status, shipped_at"}
\`;
`,
    "queries/native.sql": sqlserver
      ? `-- name: topProducts
SELECT TOP (@limit) id, sku, weight FROM products
WHERE weight >= @minimumWeight ORDER BY price_cents DESC;
`
      : `-- name: productAnalytics
SELECT id, details, prices, dimensions, fulfillment,
       row_number() OVER (PARTITION BY active ORDER BY price_cents DESC) AS rank
FROM products QUALIFY rank <= $limit;
`,
    "workflows/batch.ts": `import type { ${databaseType} } from "@typed-sql/${dialect}/runtime";
import { accountById } from "../queries/account.ts";
import { catalog } from "../queries/catalog.ts";
import { orderDocument } from "../queries/order-json.ts";

// Native batches are atomic and preserve an ordered tuple of results.
export async function loadDashboard(database: ${databaseType}) {
  const [accounts, products, orders] = await database.batch([
    accountById(42n), catalog(2500), orderDocument(9001n)
  ]);
  return { accounts, products, orders };
}
`,
    "workflows/checkout.ts": `import type { ${databaseType} } from "@typed-sql/${dialect}/runtime";
import { insertProducts } from "../queries/insert-products.ts";
import { recordAudit } from "../queries/audit.ts";
export async function importCatalog(database: ${databaseType}) {
  return database.transaction(async transaction => {
    const products = await transaction.all(insertProducts([{ id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 }]));
    const audit = await transaction.one(recordAudit(5001n, 42n, { source: "supplier-feed", productIds: [101], approved: true }, "2026-11-02T12:00:00.0000000Z"));
    return { products, audit };
  });
}
`,
    "app.ts": `import revenueByCustomer from "./queries/revenue.sql";
import nativeQuery from "./queries/native.sql";
import { accountById } from "./queries/account.ts";
import { orderDocument } from "./queries/order-json.ts";
import { insertProducts } from "./queries/insert-products.ts";
import { insertPair } from "./queries/insert-pair.ts";
import { catalog, markShipped } from "./queries/catalog.ts";
import { recordAudit } from "./queries/audit.ts";
import type { QueryRow, QueryParameters } from "@typed-sql/core";

const account = accountById(42n);
const revenue = revenueByCustomer(${sqlserver ? "{ minimumRevenue: 10000 }" : "10000n"});
const document = orderDocument(9001n);
const inserted = insertProducts([{ id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 }]);
const pair = insertPair({ id: 102n, sku: "LAMP-01", title: "Lamp", priceCents: 8900 }, { id: 103n, sku: "CHAIR-01", title: "Chair", priceCents: 15900 });
const products = catalog(2500);
const shipped = markShipped(9001n, "2026-11-02T12:00:00.0000000Z");
const audit = recordAudit(5001n, 42n, { source: "supplier-feed", productIds: [101], approved: true }, "2026-11-02T12:00:00.0000000Z");
const native = nativeQuery(${sqlserver ? '{ limit: 5n, minimumWeight: "0.100000" }' : "{ limit: 5n }"});
type Account = QueryRow<typeof account>;
type Document = QueryRow<typeof document>;
type Native = QueryRow<typeof native>;
type Bound = QueryParameters<typeof native>;
// Open queries/native.sql to inspect ${sqlserver ? "TOP and exact DECIMAL input" : "native STRUCT/MAP/ARRAY/UNION fields and QUALIFY"}.
// SQL is analyzed by the selected grammar; this browser never opens a database.
`,
  };
  return files as WorkspaceFiles & Record<"queries/account.ts" | "app.ts" | "schema/tables.sql", string>;
}
