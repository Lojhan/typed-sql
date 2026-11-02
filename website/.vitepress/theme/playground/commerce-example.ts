import type { WorkspaceFiles } from "./workspace.js";

// PostgreSQL commerce workspace: maintained, analyzed examples used by the product walkthrough.
export const COMMERCE_FILES = {
  "schema/tables.sql": `CREATE TYPE account_status AS ENUM ('active', 'suspended');
CREATE TYPE order_status AS ENUM ('draft', 'paid', 'shipped', 'cancelled');
CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE users (
  id bigint PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status account_status NOT NULL,
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE teams (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE
);

CREATE TABLE memberships (
  user_id bigint NOT NULL REFERENCES users(id),
  team_id bigint NOT NULL REFERENCES teams(id),
  role membership_role NOT NULL,
  PRIMARY KEY (user_id, team_id)
);

CREATE TABLE products (
  id bigint PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  title text NOT NULL,
  price_cents integer NOT NULL,
  active boolean NOT NULL,
  metadata jsonb
);

CREATE TABLE orders (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  status order_status NOT NULL,
  total_cents integer NOT NULL,
  created_at timestamptz NOT NULL,
  shipped_at timestamptz
);

CREATE TABLE order_items (
  order_id bigint NOT NULL REFERENCES orders(id),
  product_id bigint NOT NULL REFERENCES products(id),
  quantity integer NOT NULL,
  unit_price_cents integer NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE audit_events (
  id bigint PRIMARY KEY,
  user_id bigint REFERENCES users(id),
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
`,
  "schema/functions.sql": `CREATE FUNCTION display_email(value text) RETURNS text
LANGUAGE SQL IMMUTABLE AS $$ SELECT lower(value) $$;
`,
  "queries/account.ts": `import { sql } from "@typed-sql/postgres";

// One user can have no team. The LEFT JOIN keeps that fact in the row.
export const accountById = (id: bigint) => sql\`
  SELECT u.id, u.email, u.display_name, u.status,
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
  GROUP BY o.id, o.status, u.email
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
import type { QueryRow, QueryParameters } from "@typed-sql/core";

const account = accountById(42n);
const revenue = revenueByCustomer(10000);
const document = orderDocument(9001n);
const inserted = insertProducts([
  { id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 },
  { id: 102n, sku: "LAMP-01", title: "Task lamp", priceCents: 8900 }
]);

type Account = QueryRow<typeof account>;
type OrderDocument = QueryRow<typeof document>;
type RevenueParameters = QueryParameters<typeof revenue>;

// Explore workflows/ for exact batch results and an atomic import.
// This workspace checks types; it never opens a database connection.
`,
} satisfies WorkspaceFiles;
