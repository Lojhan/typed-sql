INSERT INTO users (id, email, status, profile, active) VALUES
  (1, 'alice@example.com', 'active', JSON_OBJECT('plan', 'pro'), 1),
  (2, 'bob@example.com', 'suspended', JSON_OBJECT('plan', 'free'), 0);

INSERT INTO projects (id, owner_id, name, budget) VALUES
  (1, 1, 'Compiler', 12500.50);

INSERT INTO codec_fidelity VALUES (
  1,
  1,
  127,
  32767,
  8388607,
  2147483647,
  9007199254740993,
  12345678901234567890.1234567890,
  1.25,
  2.5,
  b'10100101',
  'codec',
  'typed-sql',
  X'00A5FF',
  X'0102FEFF',
  '2026-08-25',
  '2026-08-25 12:34:56.789',
  '2026-08-25 12:34:56.789',
  '12:34:56',
  2026,
  JSON_OBJECT('kind', 'json', 'count', 1),
  'ready',
  'read,write',
  NULL
);
