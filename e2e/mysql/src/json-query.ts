import { sql } from "@typed-sql/mysql";

export const mysqlJsonProjection = sql`
  SELECT JSON_OBJECT(
    'id', id,
    'wide', bigint_value,
    'amount', decimal_value,
    'date', date_value,
    'tiny', boolean_value,
    'nested', JSON_ARRAY(TRUE, NULL),
    'unchecked', json_value
  ) AS document
  FROM codec_fidelity
  WHERE id = ${1}
`;

export const mysqlJsonMutations = sql`
  SELECT JSON_EXTRACT('{"items":[{"id":1},null]}', '$.items[0].id') AS selected,
         JSON_EXTRACT('"hello"', '$') AS scalar_text,
         JSON_UNQUOTE(JSON_EXTRACT('"hello"', '$')) AS sql_text,
         JSON_SET('{"items":[1]}', '$.items[9]', TRUE) AS appended,
         JSON_ARRAY_INSERT('[1,2]', '$[last]', 3) AS inserted,
         JSON_MERGE_PRESERVE('{"a":1}', '{"a":2}') AS merged
  FROM codec_fidelity
  WHERE id = ${1}
`;

export const mysqlJsonEmptyAggregate = sql`
  SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id)) AS aggregate
  FROM codec_fidelity
  WHERE id = ${0}
`;
