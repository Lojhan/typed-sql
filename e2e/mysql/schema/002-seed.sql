INSERT INTO users (id, email, status, profile, active) VALUES
  (1, 'alice@example.com', 'active', JSON_OBJECT('plan', 'pro'), 1),
  (2, 'bob@example.com', 'suspended', JSON_OBJECT('plan', 'free'), 0);

INSERT INTO projects (id, owner_id, name, budget) VALUES
  (1, 1, 'Compiler', 12500.50);
