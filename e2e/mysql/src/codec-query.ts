import { sql } from "@typed-sql/mysql";

export const mysqlCodecFidelity = sql`
  SELECT id,
         boolean_value,
         tinyint_value,
         smallint_value,
         mediumint_value,
         integer_value,
         bigint_value,
         decimal_value,
         float_value,
         double_value,
         bit_value,
         text_value,
         varchar_value,
         binary_value,
         blob_value,
         date_value,
         datetime_value,
         timestamp_value,
         time_value,
         year_value,
         json_value,
         enum_value,
         set_value,
         nullable_text
  FROM codec_fidelity
  WHERE id = ${1}
`;
