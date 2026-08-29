PRAGMA foreign_keys = ON;

CREATE TABLE account (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
) STRICT;

CREATE TABLE project (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES account(id),
  name TEXT NOT NULL,
  budget REAL
) STRICT;

INSERT INTO account (id, email, status) VALUES
  (1, 'alice@example.com', 'active'),
  (2, 'bob@example.com', 'suspended');

INSERT INTO project (id, owner_id, name, budget) VALUES
  (1, 1, 'Compiler', 12500.50);
