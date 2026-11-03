CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  profile JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teams (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name TEXT NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE memberships (
  user_id BIGINT UNSIGNED NOT NULL,
  team_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner', 'admin', 'member') NOT NULL,
  PRIMARY KEY (user_id, team_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(255) NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price_cents integer NOT NULL,
  active boolean NOT NULL,
  metadata JSON
);

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  status ENUM('draft', 'paid', 'shipped', 'cancelled') NOT NULL,
  total_cents integer NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  shipped_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE order_items (
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity integer NOT NULL,
  unit_price_cents integer NOT NULL,
  PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED,
  event_name TEXT NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO users (id, email, status, display_name) VALUES
  (1, 'alice@example.com', 'active', 'Alice'),
  (2, 'bob@example.com', 'suspended', 'Bob');

INSERT INTO teams (id, name, slug) VALUES (1, 'Studio', 'studio');
INSERT INTO memberships (user_id, team_id, role) VALUES (1, 1, 'owner');
INSERT INTO products (id, sku, title, price_cents, active) VALUES (1, 'DESK-01', 'Studio desk', 12500, true);
INSERT INTO orders (id, user_id, status, total_cents) VALUES (1, 1, 'paid', 12500);
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (1, 1, 1, 12500);
