CREATE TABLE customer_preference (
  customer_id INTEGER PRIMARY KEY,
  theme TEXT NOT NULL CHECK (theme IN ('light', 'dark')),
  email_notifications INTEGER NOT NULL CHECK (email_notifications IN (0, 1))
) STRICT;

INSERT INTO customer_preference (customer_id, theme, email_notifications) VALUES
  (1, 'dark', 1),
  (2, 'light', 0);
