// Exact previous shipped templates, used only to upgrade unchanged saved examples.
// Any edit prevents replacement, so custom projects retain their original files.
export const PREVIOUS_EXAMPLES = [
  {
    dialect: "postgres",
    lesson: "commerce",
    files: {
      "schema/tables.sql":
        "CREATE TYPE account_status AS ENUM ('active', 'suspended');\nCREATE TYPE order_status AS ENUM ('draft', 'paid', 'shipped', 'cancelled');\nCREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');\n\nCREATE TABLE users (\n  id bigint PRIMARY KEY,\n  email text NOT NULL UNIQUE,\n  display_name text NOT NULL,\n  status account_status NOT NULL,\n  profile jsonb NOT NULL,\n  created_at timestamptz NOT NULL\n);\n\nCREATE TABLE teams (\n  id bigint PRIMARY KEY,\n  name text NOT NULL,\n  slug text NOT NULL UNIQUE\n);\n\nCREATE TABLE memberships (\n  user_id bigint NOT NULL REFERENCES users(id),\n  team_id bigint NOT NULL REFERENCES teams(id),\n  role membership_role NOT NULL,\n  PRIMARY KEY (user_id, team_id)\n);\n\nCREATE TABLE products (\n  id bigint PRIMARY KEY,\n  sku text NOT NULL UNIQUE,\n  title text NOT NULL,\n  price_cents integer NOT NULL,\n  active boolean NOT NULL,\n  metadata jsonb\n);\n\nCREATE TABLE orders (\n  id bigint PRIMARY KEY,\n  user_id bigint NOT NULL REFERENCES users(id),\n  status order_status NOT NULL,\n  total_cents integer NOT NULL,\n  created_at timestamptz NOT NULL,\n  shipped_at timestamptz\n);\n\nCREATE TABLE order_items (\n  order_id bigint NOT NULL REFERENCES orders(id),\n  product_id bigint NOT NULL REFERENCES products(id),\n  quantity integer NOT NULL,\n  unit_price_cents integer NOT NULL,\n  PRIMARY KEY (order_id, product_id)\n);\n\nCREATE TABLE audit_events (\n  id bigint PRIMARY KEY,\n  user_id bigint REFERENCES users(id),\n  event_name text NOT NULL,\n  payload jsonb NOT NULL,\n  created_at timestamptz NOT NULL\n);\n",
      "schema/functions.sql":
        "CREATE FUNCTION display_email(value text) RETURNS text\nLANGUAGE SQL IMMUTABLE AS $$ SELECT lower(value) $$;\n",
      "queries/account.ts":
        'import { sql } from "@typed-sql/postgres";\n\n// One user can have no team. The LEFT JOIN keeps that fact in the row.\nexport const accountById = (id: bigint) => sql`\n  SELECT u.id, u.email, u.display_name, u.status,\n         t.name AS team_name, m.role\n  FROM users AS u\n  LEFT JOIN memberships AS m ON m.user_id = u.id\n  LEFT JOIN teams AS t ON t.id = m.team_id\n  WHERE u.id = ${id}\n`;\n',
      "queries/revenue.sql":
        "-- name: revenueByCustomer\nWITH paid_orders AS (\n  SELECT user_id, COUNT(*) AS order_count,\n         SUM(total_cents) AS revenue_cents\n  FROM orders\n  WHERE status = 'paid'\n  GROUP BY user_id\n)\nSELECT u.id, display_email(u.email) AS email,\n       p.order_count, p.revenue_cents\nFROM users AS u\nJOIN paid_orders AS p ON p.user_id = u.id\nWHERE p.revenue_cents >= $1\nORDER BY p.revenue_cents DESC;\n",
      "queries/order-json.ts":
        "import { sql } from \"@typed-sql/postgres\";\n\n// JSON constructors prove a shape. Arbitrary stored JSON stays unknown.\nexport const orderDocument = (orderId: bigint) => sql`\n  SELECT o.id, jsonb_build_object(\n    'id', o.id,\n    'status', o.status::text,\n    'customer', jsonb_build_object('email', u.email),\n    'items', COALESCE(jsonb_agg(jsonb_build_object(\n      'sku', p.sku, 'quantity', i.quantity,\n      'unitPriceCents', i.unit_price_cents\n    )), '[]'::jsonb)\n  ) AS document\n  FROM orders AS o\n  JOIN users AS u ON u.id = o.user_id\n  JOIN order_items AS i ON i.order_id = o.id\n  JOIN products AS p ON p.id = i.product_id\n  WHERE o.id = ${orderId}\n  GROUP BY o.id, o.status, u.email\n`;\n",
      "queries/insert-products.ts":
        'import { sql } from "@typed-sql/postgres";\n\nexport interface NewProduct {\n  readonly id: bigint;\n  readonly sku: string;\n  readonly title: string;\n  readonly priceCents: number;\n}\n\n// One INSERT for a runtime-sized collection. Values stay bound parameters.\nexport function insertProducts(items: readonly NewProduct[]) {\n  if (!items.length) throw new RangeError("At least one product is required");\n  return sql`\n    INSERT INTO products (id, sku, title, price_cents, active)\n    VALUES ${items.map((item) => sql.fragment`\n      (${item.id}, ${item.sku}, ${item.title}, ${item.priceCents}, ${true})\n    `)}\n    RETURNING id, sku, price_cents\n  `;\n}\n',
      "queries/insert-pair.ts":
        'import { sql } from "@typed-sql/postgres";\nimport type { NewProduct } from "./insert-products.ts";\n\n// Fixed cardinality keeps an exact, ordered parameter tuple.\nexport const insertPair = (first: NewProduct, second: NewProduct) => sql`\n  INSERT INTO products (id, sku, title, price_cents, active)\n  VALUES (${first.id}, ${first.sku}, ${first.title}, ${first.priceCents}, ${true}),\n         (${second.id}, ${second.sku}, ${second.title}, ${second.priceCents}, ${true})\n  RETURNING id, sku, price_cents\n`;\n',
      "queries/audit.ts":
        "import { sql } from \"@typed-sql/postgres\";\n\nexport interface AuditPayload {\n  readonly source: string;\n  readonly productIds: readonly number[];\n  readonly approved: boolean;\n}\n\n// JSON is validated and snapshotted as a single bound value.\nexport const recordAudit = (id: bigint, userId: bigint, payload: AuditPayload, createdAt: Date) => sql`\n  INSERT INTO audit_events (id, user_id, event_name, payload, created_at)\n  VALUES (${id}, ${userId}, 'catalog.imported', ${sql.json(payload)}, ${createdAt})\n  RETURNING id, event_name\n`;\n",
      "queries/catalog.ts":
        "import { sql } from \"@typed-sql/postgres\";\n\nexport const catalog = (minimumPrice: number) => sql`\n  SELECT id, sku, title, price_cents\n  FROM products\n  WHERE active = ${true} AND price_cents >= ${minimumPrice}\n  ORDER BY price_cents DESC\n`;\n\nexport const markShipped = (orderId: bigint, shippedAt: Date) => sql`\n  UPDATE orders SET status = 'shipped'::order_status, shipped_at = ${shippedAt}\n  WHERE id = ${orderId} AND status = 'paid'\n  RETURNING id, status, shipped_at\n`;\n",
      "workflows/batch.ts":
        'import type { PostgresDatabase } from "@typed-sql/postgres/runtime";\nimport { accountById } from "../queries/account.ts";\nimport { catalog } from "../queries/catalog.ts";\nimport { orderDocument } from "../queries/order-json.ts";\n\n// A root batch is sequential on one connection; it is not atomic.\nexport async function loadDashboard(database: PostgresDatabase) {\n  const [accounts, products, orders] = await database.batch([\n    accountById(42n), catalog(2500), orderDocument(9001n)\n  ]);\n  return { accounts, products, orders };\n}\n\n',
      "workflows/checkout.ts":
        'import type { PostgresDatabase } from "@typed-sql/postgres/runtime";\nimport { insertProducts } from "../queries/insert-products.ts";\nimport { recordAudit } from "../queries/audit.ts";\n\nexport async function importCatalog(database: PostgresDatabase) {\n  return database.transaction(async (transaction) => {\n    const products = await transaction.all(insertProducts([\n      { id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 },\n      { id: 102n, sku: "LAMP-01", title: "Task lamp", priceCents: 8900 }\n    ]));\n    const audit = await transaction.one(recordAudit(5001n, 42n, {\n      source: "supplier-feed", productIds: [101, 102], approved: true\n    }, new Date("2026-11-02T12:00:00Z")));\n    return { products, audit };\n  });\n}\n',
      "app.ts":
        'import revenueByCustomer from "./queries/revenue.sql";\nimport { accountById } from "./queries/account.ts";\nimport { orderDocument } from "./queries/order-json.ts";\nimport { insertProducts } from "./queries/insert-products.ts";\nimport type { QueryRow, QueryParameters } from "@typed-sql/core";\n\nconst account = accountById(42n);\nconst revenue = revenueByCustomer(10000);\nconst document = orderDocument(9001n);\nconst inserted = insertProducts([\n  { id: 101n, sku: "DESK-01", title: "Studio desk", priceCents: 24900 },\n  { id: 102n, sku: "LAMP-01", title: "Task lamp", priceCents: 8900 }\n]);\n\ntype Account = QueryRow<typeof account>;\ntype OrderDocument = QueryRow<typeof document>;\ntype RevenueParameters = QueryParameters<typeof revenue>;\n\n// Explore workflows/ for exact batch results and an atomic import.\n// This workspace checks types; it never opens a database connection.\n',
    },
  },
  {
    dialect: "postgres",
    lesson: "workspace",
    files: {
      "queries/account.sql": "-- name: accountById\nSELECT id, email, status\nFROM users\nWHERE id = $1;\n",
      "queries/summary.ts":
        'import { sql } from "@typed-sql/postgres";\n\nexport const accountSummary = sql`SELECT id, display_email(email) AS label FROM users`;\n',
      "schema/functions.sql":
        "CREATE FUNCTION display_email(value text) RETURNS text\nLANGUAGE SQL IMMUTABLE AS $$ SELECT upper(value) $$;\n",
      "queries/account.ts":
        'import { sql } from "@typed-sql/postgres";\n\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM users AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import accountFromSql from "./queries/account.sql";\nimport { accountById } from "./queries/account.ts";\nimport { accountSummary } from "./queries/summary.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\nconst sqlQuery = accountFromSql(42n);\nconst templateQuery = accountById(42n);\n\ntype Account = QueryRow<typeof sqlQuery>;\ntype Parameters = QueryParameters<typeof sqlQuery>;\n\n// Type-only adapter example. No database runs in the playground.\ndeclare const database: Database;\nconst sqlRows = await database.all(sqlQuery);\nconst templateRows = await database.all(templateQuery);\nconst summaryRows = await database.all(accountSummary);\n',
      "schema/tables.sql":
        "CREATE TYPE account_status AS ENUM ('active', 'suspended');\n\nCREATE TABLE users (\n  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  email text NOT NULL UNIQUE,\n  status account_status NOT NULL DEFAULT 'active',\n  name text NOT NULL DEFAULT '',\n  budget numeric(14, 2),\n  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL,\n  name text NOT NULL,\n  budget numeric(14, 2)\n);\n\nCREATE TABLE account (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL DEFAULT 'active',\n  note text\n);\n\nCREATE TABLE projects (\n  id bigint PRIMARY KEY,\n  owner_id bigint NOT NULL REFERENCES users(id),\n  name text NOT NULL,\n  budget numeric(14, 2)\n);",
    },
  },
  {
    dialect: "postgres",
    lesson: "basics",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/postgres";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM users AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TYPE account_status AS ENUM ('active', 'suspended');\n\nCREATE TABLE users (\n  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  email text NOT NULL UNIQUE,\n  status account_status NOT NULL DEFAULT 'active',\n  name text NOT NULL DEFAULT '',\n  budget numeric(14, 2),\n  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL,\n  name text NOT NULL,\n  budget numeric(14, 2)\n);\n\nCREATE TABLE account (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL DEFAULT 'active',\n  note text\n);\n\nCREATE TABLE projects (\n  id bigint PRIMARY KEY,\n  owner_id bigint NOT NULL REFERENCES users(id),\n  name text NOT NULL,\n  budget numeric(14, 2)\n);",
    },
  },
  {
    dialect: "postgres",
    lesson: "joins",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/postgres";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, project.name AS project_name\n  FROM users AS account\n  LEFT JOIN projects AS project ON project.owner_id = account.id\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TYPE account_status AS ENUM ('active', 'suspended');\n\nCREATE TABLE users (\n  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  email text NOT NULL UNIQUE,\n  status account_status NOT NULL DEFAULT 'active',\n  name text NOT NULL DEFAULT '',\n  budget numeric(14, 2),\n  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL,\n  name text NOT NULL,\n  budget numeric(14, 2)\n);\n\nCREATE TABLE account (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL DEFAULT 'active',\n  note text\n);\n\nCREATE TABLE projects (\n  id bigint PRIMARY KEY,\n  owner_id bigint NOT NULL REFERENCES users(id),\n  name text NOT NULL,\n  budget numeric(14, 2)\n);",
    },
  },
  {
    dialect: "postgres",
    lesson: "errors",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/postgres";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM users AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById("42");\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TYPE account_status AS ENUM ('active', 'suspended');\n\nCREATE TABLE users (\n  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  email text NOT NULL UNIQUE,\n  status account_status NOT NULL DEFAULT 'active',\n  name text NOT NULL DEFAULT '',\n  budget numeric(14, 2),\n  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL,\n  name text NOT NULL,\n  budget numeric(14, 2)\n);\n\nCREATE TABLE account (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL DEFAULT 'active',\n  note text\n);\n\nCREATE TABLE projects (\n  id bigint PRIMARY KEY,\n  owner_id bigint NOT NULL REFERENCES users(id),\n  name text NOT NULL,\n  budget numeric(14, 2)\n);",
    },
  },
  {
    dialect: "postgres",
    lesson: "unknown",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/postgres";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql.dynamic("SELECT * FROM account");\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TYPE account_status AS ENUM ('active', 'suspended');\n\nCREATE TABLE users (\n  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  email text NOT NULL UNIQUE,\n  status account_status NOT NULL DEFAULT 'active',\n  name text NOT NULL DEFAULT '',\n  budget numeric(14, 2),\n  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL,\n  name text NOT NULL,\n  budget numeric(14, 2)\n);\n\nCREATE TABLE account (\n  id bigint PRIMARY KEY,\n  email text NOT NULL,\n  status account_status NOT NULL DEFAULT 'active',\n  note text\n);\n\nCREATE TABLE projects (\n  id bigint PRIMARY KEY,\n  owner_id bigint NOT NULL REFERENCES users(id),\n  name text NOT NULL,\n  budget numeric(14, 2)\n);",
    },
  },
  {
    dialect: "mysql",
    lesson: "workspace",
    files: {
      "queries/account.sql": "-- name: accountById\nSELECT id, email, status\nFROM users\nWHERE id = ?;\n",
      "queries/summary.ts":
        'import { sql } from "@typed-sql/mysql";\n\nexport const accountSummary = sql`SELECT id, display_email(email) AS label FROM users`;\n',
      "schema/functions.sql":
        "CREATE FUNCTION display_email(value TEXT) RETURNS TEXT\nDETERMINISTIC RETURN UPPER(value);\n",
      "queries/account.ts":
        'import { sql } from "@typed-sql/mysql";\n\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM users AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import accountFromSql from "./queries/account.sql";\nimport { accountById } from "./queries/account.ts";\nimport { accountSummary } from "./queries/summary.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\nconst sqlQuery = accountFromSql(42n);\nconst templateQuery = accountById(42n);\n\ntype Account = QueryRow<typeof sqlQuery>;\ntype Parameters = QueryParameters<typeof sqlQuery>;\n\n// Type-only adapter example. No database runs in the playground.\ndeclare const database: Database;\nconst sqlRows = await database.all(sqlQuery);\nconst templateRows = await database.all(templateQuery);\nconst summaryRows = await database.all(accountSummary);\n',
      "schema/tables.sql":
        "CREATE TABLE users (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  name VARCHAR(120) NOT NULL DEFAULT '',\n  budget DECIMAL(14, 2),\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);\n\nCREATE TABLE account (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  note TEXT\n);\n\nCREATE TABLE projects (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  owner_id BIGINT UNSIGNED NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);",
    },
  },
  {
    dialect: "mysql",
    lesson: "basics",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/mysql";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM users AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE users (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  name VARCHAR(120) NOT NULL DEFAULT '',\n  budget DECIMAL(14, 2),\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);\n\nCREATE TABLE account (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  note TEXT\n);\n\nCREATE TABLE projects (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  owner_id BIGINT UNSIGNED NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);",
    },
  },
  {
    dialect: "mysql",
    lesson: "joins",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/mysql";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, project.name AS project_name\n  FROM users AS account\n  LEFT JOIN projects AS project ON project.owner_id = account.id\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE users (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  name VARCHAR(120) NOT NULL DEFAULT '',\n  budget DECIMAL(14, 2),\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);\n\nCREATE TABLE account (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  note TEXT\n);\n\nCREATE TABLE projects (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  owner_id BIGINT UNSIGNED NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);",
    },
  },
  {
    dialect: "mysql",
    lesson: "errors",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/mysql";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM users AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById("42");\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE users (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  name VARCHAR(120) NOT NULL DEFAULT '',\n  budget DECIMAL(14, 2),\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);\n\nCREATE TABLE account (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  note TEXT\n);\n\nCREATE TABLE projects (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  owner_id BIGINT UNSIGNED NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);",
    },
  },
  {
    dialect: "mysql",
    lesson: "unknown",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/mysql";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql.dynamic("SELECT * FROM account");\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE users (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  name VARCHAR(120) NOT NULL DEFAULT '',\n  budget DECIMAL(14, 2),\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE accounts (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);\n\nCREATE TABLE account (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',\n  note TEXT\n);\n\nCREATE TABLE projects (\n  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  owner_id BIGINT UNSIGNED NOT NULL,\n  name VARCHAR(120) NOT NULL,\n  budget DECIMAL(14, 2)\n);",
    },
  },
  {
    dialect: "sqlite",
    lesson: "workspace",
    files: {
      "queries/account.sql": "-- name: accountById\nSELECT id, email, status\nFROM account\nWHERE id = ?;\n",
      "queries/summary.ts":
        'import { sql } from "@typed-sql/sqlite";\n\nexport const accountSummary = sql`SELECT id, upper(email) AS label FROM account`;\n',
      "queries/account.ts":
        'import { sql } from "@typed-sql/sqlite";\n\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM account AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import accountFromSql from "./queries/account.sql";\nimport { accountById } from "./queries/account.ts";\nimport { accountSummary } from "./queries/summary.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\nconst sqlQuery = accountFromSql(42n);\nconst templateQuery = accountById(42n);\n\ntype Account = QueryRow<typeof sqlQuery>;\ntype Parameters = QueryParameters<typeof sqlQuery>;\n\n// Type-only adapter example. No database runs in the playground.\ndeclare const database: Database;\nconst sqlRows = await database.all(sqlQuery);\nconst templateRows = await database.all(templateQuery);\nconst summaryRows = await database.all(accountSummary);\n',
      "schema/tables.sql":
        "CREATE TABLE account (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),\n  name TEXT NOT NULL DEFAULT '',\n  budget REAL\n) STRICT;\n\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL\n) STRICT;\n\nCREATE TABLE projects (\n  id INTEGER PRIMARY KEY,\n  owner_id INTEGER NOT NULL REFERENCES account(id),\n  name TEXT NOT NULL,\n  budget REAL\n) STRICT;",
    },
  },
  {
    dialect: "sqlite",
    lesson: "basics",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/sqlite";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM account AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE account (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),\n  name TEXT NOT NULL DEFAULT '',\n  budget REAL\n) STRICT;\n\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL\n) STRICT;\n\nCREATE TABLE projects (\n  id INTEGER PRIMARY KEY,\n  owner_id INTEGER NOT NULL REFERENCES account(id),\n  name TEXT NOT NULL,\n  budget REAL\n) STRICT;",
    },
  },
  {
    dialect: "sqlite",
    lesson: "joins",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/sqlite";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, project.name AS project_name\n  FROM account AS account\n  LEFT JOIN projects AS project ON project.owner_id = account.id\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE account (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),\n  name TEXT NOT NULL DEFAULT '',\n  budget REAL\n) STRICT;\n\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL\n) STRICT;\n\nCREATE TABLE projects (\n  id INTEGER PRIMARY KEY,\n  owner_id INTEGER NOT NULL REFERENCES account(id),\n  name TEXT NOT NULL,\n  budget REAL\n) STRICT;",
    },
  },
  {
    dialect: "sqlite",
    lesson: "errors",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/sqlite";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql`\n  SELECT account.id, account.email, account.status\n  FROM account AS account\n  WHERE account.id = ${id}\n`;\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById("42");\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE account (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),\n  name TEXT NOT NULL DEFAULT '',\n  budget REAL\n) STRICT;\n\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL\n) STRICT;\n\nCREATE TABLE projects (\n  id INTEGER PRIMARY KEY,\n  owner_id INTEGER NOT NULL REFERENCES account(id),\n  name TEXT NOT NULL,\n  budget REAL\n) STRICT;",
    },
  },
  {
    dialect: "sqlite",
    lesson: "unknown",
    files: {
      "queries/account.ts":
        'import { sql } from "@typed-sql/sqlite";\n\n// Hover sql, accountById, or the interpolated id.\nexport const accountById = (id: bigint) => sql.dynamic("SELECT * FROM account");\n',
      "app.ts":
        'import { accountById } from "./queries/account.ts";\nimport type { QueryRow, QueryParameters, Database } from "@typed-sql/core";\n\n// Types follow your query across the import.\nconst query = accountById(42n);\ntype Account = QueryRow<typeof query>;\ntype Parameters = QueryParameters<typeof query>;\n\n// A type-only adapter example; no database runs in this playground.\ndeclare const database: Database;\nconst rows = await database.all(query);\nconst account = rows[0];\n\n',
      "schema/tables.sql":
        "CREATE TABLE account (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),\n  name TEXT NOT NULL DEFAULT '',\n  budget REAL\n) STRICT;\n\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL,\n  name TEXT NOT NULL,\n  created_at TEXT NOT NULL\n) STRICT;\n\nCREATE TABLE projects (\n  id INTEGER PRIMARY KEY,\n  owner_id INTEGER NOT NULL REFERENCES account(id),\n  name TEXT NOT NULL,\n  budget REAL\n) STRICT;",
    },
  },
] as const;
