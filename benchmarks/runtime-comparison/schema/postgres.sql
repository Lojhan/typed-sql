CREATE TABLE account (
  id bigint PRIMARY KEY,
  email text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  budget numeric(18, 2)
);

INSERT INTO account (id, email, status, budget)
SELECT
  value,
  'person-' || value || '@example.com',
  CASE WHEN value % 5 = 0 THEN 'suspended' ELSE 'active' END,
  value * 10.25
FROM generate_series(1, 1000) AS value;

CREATE TABLE bulk_account (
  id bigint PRIMARY KEY,
  email text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'suspended'))
);
