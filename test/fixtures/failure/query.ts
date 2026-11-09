import { sql } from "@typed-sql/postgres";

sql`SELECT usr_.missing FROM users AS usr_`;
sql`SELECT usr_.id, age.id FROM users AS usr_ JOIN users AS age ON true`;
sql`SELECT id FROM missing_table`;
