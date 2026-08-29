CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active'
);

CREATE TABLE projects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  budget DECIMAL(14, 2),
  CONSTRAINT projects_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id)
);

INSERT INTO users (id, email, status) VALUES
  (1, 'alice@example.com', 'active'),
  (2, 'bob@example.com', 'suspended');

INSERT INTO projects (owner_id, name, budget) VALUES
  (1, 'Compiler', 12500.50);
