\set ON_ERROR_STOP on

INSERT INTO public.users (id, email, status, profile) VALUES
  (1, 'alice@example.com', 'active', '{"plan":"pro"}'),
  (2, 'bob@example.com', 'suspended', '{"plan":"free"}');

SELECT setval(
  pg_get_serial_sequence('public.users', 'id'),
  (SELECT max(id) FROM public.users),
  true
);

INSERT INTO public.projects (id, owner_id, name, budget, tags) VALUES
  ('11111111-1111-1111-1111-111111111111', 1, 'Compiler', 12500.50, ARRAY['typescript', 'sql']);

INSERT INTO public.codec_fidelity VALUES (
  1,
  32767,
  2147483647,
  9007199254740993,
  12345678901234567890.1234567890,
  1.25,
  2.5,
  true,
  'codec',
  '22222222-2222-2222-2222-222222222222',
  DATE '2026-08-25',
  TIMESTAMP '2026-08-25 12:34:56.789',
  TIMESTAMPTZ '2026-08-25 12:34:56.789+00',
  '{"kind":"json","count":1}',
  '{"kind":"jsonb","enabled":true}',
  decode('00a5ff', 'hex'),
  ARRAY[1::bigint, 9007199254740993::bigint],
  ARRAY[1.25::numeric, 12345678901234567890.1234567890::numeric],
  ARRAY['one', 'two'],
  NULL
);
