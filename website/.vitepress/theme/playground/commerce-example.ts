import { COMMERCE_SCHEMAS } from "../../../../examples/shared/commerce-schema.js";
import type { PlaygroundDialect } from "./dialect-browser-runtime.js";
import { nativeCommerceFiles } from "./native-commerce-example.js";
import type { WorkspaceFiles } from "./workspace.js";

// Shared commerce scenarios used by the documentation and default playground workspace.
export const COMMERCE_FILES = {
  "schema/tables.sql": COMMERCE_SCHEMAS.postgres,
  "schema/functions.sql": `CREATE FUNCTION display_email(value text) RETURNS text
LANGUAGE SQL IMMUTABLE AS $$ SELECT lower(value) $$;
`,
  "queries/account.ts": `import { sql } from "@typed-sql/postgres";

// One user can have no team. The LEFT JOIN keeps that fact in the row.
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
  SELECT user_id, COUNT(*) AS order_count,
         SUM(total_cents) AS revenue_cents
  FROM orders
  WHERE status = 'paid'
  GROUP BY user_id
)
SELECT u.id, display_email(u.email) AS email,
       p.order_count, p.revenue_cents
FROM users AS u
JOIN paid_orders AS p ON p.user_id = u.id
WHERE p.revenue_cents >= $1
ORDER BY p.revenue_cents DESC;
`,
  "queries/order-json.ts": `import { sql } from "@typed-sql/postgres";

// JSON constructors prove a shape. Arbitrary stored JSON stays unknown.
export const orderDocument = (orderId: bigint) => sql\`
  SELECT o.id, jsonb_build_object(
    'id', o.id,
    'status', o.status::text,
    'totalCents', o.total_cents,
    'customer', jsonb_build_object('email', u.email),
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'sku', p.sku, 'quantity', i.quantity,
      'unitPriceCents', i.unit_price_cents
    )), '[]'::jsonb)
  ) AS document
  FROM orders AS o
  JOIN users AS u ON u.id = o.user_id
  JOIN order_items AS i ON i.order_id = o.id
  JOIN products AS p ON p.id = i.product_id
  WHERE o.id = \${orderId}
  GROUP BY o.id, o.status, o.total_cents, u.email
\`;
`,
  "queries/insert-products.ts": `import { sql } from "@typed-sql/postgres";

export interface NewProduct {
  readonly id: bigint;
  readonly sku: string;
  readonly title: string;
  readonly priceCents: number;
}

// One INSERT for a runtime-sized collection. Values stay bound parameters.
export function insertProducts(items: readonly NewProduct[]) {
  if (!items.length) throw new RangeError("At least one product is required");
  return sql\`
    INSERT INTO products (id, sku, title, price_cents, active)
    VALUES \${items.map((item) => sql.fragment\`
      (\${item.id}, \${item.sku}, \${item.title}, \${item.priceCents}, \${true})
    \`)}
    RETURNING id, sku, price_cents
  \`;
}
`,
  "queries/insert-pair.ts": `import { sql } from "@typed-sql/postgres";
import type { NewProduct } from "./insert-products.ts";

// Fixed cardinality keeps an exact, ordered parameter tuple.
export const insertPair = (first: NewProduct, second: NewProduct) => sql\`
  INSERT INTO products (id, sku, title, price_cents, active)
  VALUES (\${first.id}, \${first.sku}, \${first.title}, \${first.priceCents}, \${true}),
         (\${second.id}, \${second.sku}, \${second.title}, \${second.priceCents}, \${true})
  RETURNING id, sku, price_cents
\`;
`,
  "queries/audit.ts": `import { sql } from "@typed-sql/postgres";

export interface AuditPayload {
  readonly source: string;
  readonly productIds: readonly number[];
  readonly approved: boolean;
}

// JSON is validated and snapshotted as a single bound value.
export const recordAudit = (id: bigint, userId: bigint, payload: AuditPayload, createdAt: Date) => sql\`
  INSERT INTO audit_events (id, user_id, event_name, payload, created_at)
  VALUES (\${id}, \${userId}, 'catalog.imported', \${sql.json(payload)}, \${createdAt})
  RETURNING id, event_name
\`;
`,
  "queries/catalog.ts": `import { sql } from "@typed-sql/postgres";

export const catalog = (minimumPrice: number) => sql\`
  SELECT id, sku, title, price_cents
  FROM products
  WHERE active = \${true} AND price_cents >= \${minimumPrice}
  ORDER BY price_cents DESC
\`;

export const markShipped = (orderId: bigint, shippedAt: Date) => sql\`
  UPDATE orders SET status = 'shipped'::order_status, shipped_at = \${shippedAt}
  WHERE id = \${orderId} AND status = 'paid'
  RETURNING id, status, shipped_at
\`;
`,
  "workflows/batch.ts": `import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById } from "../queries/account.ts";
import { catalog } from "../queries/catalog.ts";
import { orderDocument } from "../queries/order-json.ts";

// A root batch is sequential on one connection; it is not atomic.
export async function loadDashboard(database: PostgresDatabase) {
  const [accounts, products, orders] = await database.batch([
    accountById(42n), catalog(2500), orderDocument(9001n)
  ]);
  return { accounts, products, orders };
}

`,
  "workflows/checkout.ts": `import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { insertProducts } from "../queries/insert-products.ts";
import { recordAudit } from "../queries/audit.ts";

export async function importCatalog(database: PostgresDatabase) {
  return database.transaction(async (transaction) => {
    const products = await transaction.all(insertProducts([
      { id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 },
      { id: 102n, sku: "LAMP-01", title: "Task lamp", priceCents: 8900 }
    ]));
    const audit = await transaction.one(recordAudit(5001n, 42n, {
      source: "supplier-feed", productIds: [101, 102], approved: true
    }, new Date("2026-11-02T12:00:00Z")));
    return { products, audit };
  });
}
`,
  "app.ts": `import revenueByCustomer from "./queries/revenue.sql";
import { accountById } from "./queries/account.ts";
import { orderDocument } from "./queries/order-json.ts";
import { insertProducts } from "./queries/insert-products.ts";
import { insertPair } from "./queries/insert-pair.ts";
import { catalog, markShipped } from "./queries/catalog.ts";
import { recordAudit } from "./queries/audit.ts";
import type { QueryRow, QueryParameters } from "@typed-sql/core";

const account = accountById(42n);
const revenue = revenueByCustomer(10000n);
const document = orderDocument(9001n);
const inserted = insertProducts([
  { id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 },
  { id: 102n, sku: "LAMP-01", title: "Task lamp", priceCents: 8900 }
]);

const pair = insertPair(
  { id: 103n, sku: "CHAIR-01", title: "Studio chair", priceCents: 15900 },
  { id: 104n, sku: "SHELF-01", title: "Wall shelf", priceCents: 6900 }
);
const products = catalog(2500);
const shipped = markShipped(9001n, new Date("2026-11-02T12:00:00Z"));
const audit = recordAudit(5001n, 42n, {
  source: "supplier-feed", productIds: [101, 102], approved: true
}, new Date("2026-11-02T12:00:00Z"));

type Account = QueryRow<typeof account>;
type OrderDocument = QueryRow<typeof document>;
type RevenueParameters = QueryParameters<typeof revenue>;

// Explore workflows/ for exact batch results and an atomic import.
// This workspace checks types; it never opens a database connection.
`,
} satisfies WorkspaceFiles;

/** Keep the same application model and scenarios while respecting each grammar's native contracts. */
export function commerceFiles(
  dialect: PlaygroundDialect,
): WorkspaceFiles & Record<"queries/account.ts" | "app.ts" | "schema/tables.sql", string> {
  if (dialect === "sqlserver" || dialect === "duckdb") return nativeCommerceFiles(dialect);
  const files: WorkspaceFiles = Object.fromEntries(
    Object.entries(COMMERCE_FILES).map(([path, source]) => [
      path,
      source
        .replaceAll("@typed-sql/postgres", `@typed-sql/${dialect}`)
        .replaceAll(
          "PostgresDatabase",
          dialect === "mysql" ? "MySqlDatabase" : dialect === "sqlite" ? "SqliteDatabase" : "PostgresDatabase",
        ),
    ]),
  );
  files["schema/tables.sql"] = COMMERCE_SCHEMAS[dialect];
  if (dialect === "postgres") {
    return files as WorkspaceFiles & Record<"queries/account.ts" | "app.ts" | "schema/tables.sql", string>;
  }
  files["queries/revenue.sql"] = files["queries/revenue.sql"]!.replace("$1", "?");
  for (const path of ["queries/order-json.ts", "queries/catalog.ts"])
    files[path] = files[path]!.replaceAll("::text", "").replaceAll("::order_status", "");
  if (dialect === "mysql") {
    files["app.ts"] = files["app.ts"]!.replace("revenueByCustomer(10000n)", 'revenueByCustomer("10000")');
    files["schema/functions.sql"] =
      "CREATE FUNCTION display_email(value TEXT) RETURNS TEXT\nDETERMINISTIC RETURN LOWER(value);\n";
    files["queries/order-json.ts"] = files["queries/order-json.ts"]!.replaceAll("jsonb_build_object", "JSON_OBJECT")
      .replaceAll("jsonb_agg", "JSON_ARRAYAGG")
      .replace("'[]'::jsonb", "JSON_ARRAY()");
    for (const [path, source] of Object.entries(files)) files[path] = source.replace(/\n[ \t]*RETURNING [^\n]+/gu, "");
    files["workflows/checkout.ts"] = files["workflows/checkout.ts"]!.replace(
      "transaction.all(insertProducts",
      "transaction.execute(insertProducts",
    ).replace("transaction.one(recordAudit", "transaction.execute(recordAudit");
  } else {
    delete files["schema/functions.sql"];
    files["queries/audit.ts"] = files["queries/audit.ts"]!.replace(
      "sql.json(payload)",
      "JSON.stringify(payload)",
    ).replace(
      "JSON is validated and snapshotted as a single bound value.",
      "SQLite stores JSON text; serialize the payload explicitly before binding it.",
    );
    files["queries/revenue.sql"] = files["queries/revenue.sql"]!.replace("display_email", "lower");
    files["queries/order-json.ts"] = files["queries/order-json.ts"]!.replaceAll("jsonb_build_object", "json_object")
      .replaceAll("jsonb_agg", "json_group_array")
      .replace("'[]'::jsonb", "json_array()");
    for (const [path, source] of Object.entries(files)) {
      files[path] = source
        .replaceAll("priceCents: number", "priceCents: bigint")
        .replaceAll("minimumPrice: number", "minimumPrice: bigint")
        .replaceAll("createdAt: Date", "createdAt: string")
        .replaceAll("shippedAt: Date", "shippedAt: string")
        .replaceAll("${true}", "${1n}")
        .replace(/priceCents: (\d+)\b/gu, "priceCents: $1n")
        .replaceAll("catalog(2500)", "catalog(2500n)")
        .replaceAll("revenueByCustomer(10000)", "revenueByCustomer(10000n)")
        .replaceAll('new Date("2026-11-02T12:00:00Z")', '"2026-11-02T12:00:00Z"');
    }
  }
  return files as WorkspaceFiles & Record<"queries/account.ts" | "app.ts" | "schema/tables.sql", string>;
}
