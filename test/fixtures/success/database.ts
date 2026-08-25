import { createDatabase } from "@typed-sql/core";

export const db = createDatabase(
  {
    async execute(): Promise<readonly unknown[]> {
      return [];
    },
  },
  {
    placeholder: (index) => `$${index}`,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  },
);
