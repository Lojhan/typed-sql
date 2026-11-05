SELECT id, name, payload, bytes, maybe, CAST(1 AS REAL) AS real FROM items WHERE id = :id OR id = :id
