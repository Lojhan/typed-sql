INSERT INTO items (id, name, payload, bytes, maybe) VALUES (:id, :name, :payload, :bytes, :maybe) RETURNING id, name
