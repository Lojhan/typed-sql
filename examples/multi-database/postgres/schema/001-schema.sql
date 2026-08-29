CREATE TABLE customer (
  id BIGINT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);

INSERT INTO customer (id, email, display_name) VALUES
  (1, 'alice@example.com', 'Alice'),
  (2, 'bob@example.com', 'Bob');
