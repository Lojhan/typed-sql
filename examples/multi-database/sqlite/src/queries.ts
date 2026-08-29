import { sql } from "@typed-sql/sqlite";

export const preferenceByCustomerId = (customerId: bigint) => sql`
  SELECT preference.customer_id, preference.theme, preference.email_notifications
  FROM customer_preference AS preference
  WHERE preference.customer_id = ${customerId}
`;

export const updatePreference = (customerId: bigint, theme: string, emailNotifications: 0n | 1n) => sql`
  UPDATE customer_preference
  SET theme = ${theme}, email_notifications = ${emailNotifications}
  WHERE customer_id = ${customerId}
  RETURNING customer_id, theme, email_notifications
`;
