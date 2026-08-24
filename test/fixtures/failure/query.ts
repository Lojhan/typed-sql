import { sql } from "./generated/db/index.js";

sql`SELECT user.missing FROM users AS user`;
sql`SELECT user.id, age.id FROM users AS user JOIN users AS age ON true`;
sql`SELECT id FROM missing_table`;
