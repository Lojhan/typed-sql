import { sql } from "@typed-sql/postgres";

export const postgresCodecFidelity = sql`
  SELECT id,
         smallint_value,
         integer_value,
         bigint_value,
         numeric_value,
         real_value,
         double_value,
         boolean_value,
         text_value,
         uuid_value,
         date_value,
         timestamp_value,
         timestamptz_value,
         json_value,
         jsonb_value,
         binary_value,
         bigint_array,
         numeric_array,
         text_array,
         nullable_text
  FROM codec_fidelity
  WHERE id = ${1}
`;
