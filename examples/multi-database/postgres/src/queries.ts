import { sql } from "@typed-sql/postgres";

export const customerById = (customerId: bigint) => sql`
  SELECT customer.id, customer.email, customer.display_name
  FROM customer
  WHERE customer.id = ${customerId}
`;
