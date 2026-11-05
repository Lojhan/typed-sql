SELECT jsonb(payload) AS binary, json_extract(payload, '$.name') AS name FROM items WHERE id = :id
