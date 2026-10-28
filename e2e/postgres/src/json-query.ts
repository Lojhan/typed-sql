import { sql } from "@typed-sql/postgres";

export const postgresJsonProjection = sql`
  SELECT jsonb_build_object(
    'id', id,
    'wide', bigint_value,
    'amount', numeric_value,
    'date', date_value,
    'bytes', binary_value,
    'nullable', nullable_text,
    'nested', jsonb_build_object('enabled', boolean_value),
    'unchecked', jsonb_value
  ) AS document
  FROM codec_fidelity
  WHERE id = ${1}
`;

export const postgresJsonEmptyAggregate = sql`
  SELECT jsonb_agg(jsonb_build_object('id', id)) AS aggregate,
         COALESCE(jsonb_agg(jsonb_build_object('id', id)), '[]'::jsonb) AS fallback
  FROM codec_fidelity
  WHERE id = ${0}
`;

export const postgresJsonNonfinite = sql`
  SELECT jsonb_build_object(
    'numeric', 'NaN'::numeric,
    'float', 'Infinity'::float8
  ) AS document
`;
