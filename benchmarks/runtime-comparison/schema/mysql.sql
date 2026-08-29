CREATE TABLE account (
  id bigint PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  status enum('active', 'suspended') NOT NULL,
  budget decimal(18, 2)
);

INSERT INTO account (id, email, status, budget)
WITH RECURSIVE sequence AS (
  SELECT 1 AS value
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 1000
)
SELECT
  value,
  CONCAT('person-', value, '@example.com'),
  IF(MOD(value, 5) = 0, 'suspended', 'active'),
  value * 10.25
FROM sequence;

CREATE TABLE bulk_account (
  id bigint PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  status enum('active', 'suspended') NOT NULL
);
