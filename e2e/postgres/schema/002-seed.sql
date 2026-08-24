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
