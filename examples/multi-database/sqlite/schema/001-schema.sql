PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT CHECK (status IN ('active', 'suspended')) NOT NULL DEFAULT 'active',
  profile TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  role TEXT CHECK (role IN ('owner', 'admin', 'member')) NOT NULL,
  PRIMARY KEY (user_id, team_id)
) STRICT;

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  active INTEGER NOT NULL,
  metadata TEXT
) STRICT;

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT CHECK (status IN ('draft', 'paid', 'shipped', 'cancelled')) NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  shipped_at TEXT
) STRICT;

CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  event_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

INSERT INTO users (id, email, status, display_name) VALUES
  (1, 'alice@example.com', 'active', 'Alice'),
  (2, 'bob@example.com', 'suspended', 'Bob');

INSERT INTO teams (id, name, slug) VALUES (1, 'Studio', 'studio');
INSERT INTO memberships (user_id, team_id, role) VALUES (1, 1, 'owner');
INSERT INTO products (id, sku, title, price_cents, active) VALUES (1, 'DESK-01', 'Studio desk', 12500, 1);
INSERT INTO orders (id, user_id, status, total_cents) VALUES (1, 1, 'paid', 12500);
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (1, 1, 1, 12500);

UPDATE users SET profile = '{"theme":"dark","emailNotifications":true}' WHERE id = 1;
UPDATE users SET profile = '{"theme":"light","emailNotifications":false}' WHERE id = 2;
