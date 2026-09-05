import type { PostgresSchemaSnapshot } from "../../../postgres/src/index.js";

export function usersSchema() {
  return {
    formatVersion: 1,
    dialect: "postgres",
    tables: {
      users: {
        name: "users",
        columns: {
          id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
          email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
        },
      },
    },
  } as const satisfies PostgresSchemaSnapshot;
}
