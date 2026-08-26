import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.POSTGRES_URL ?? "postgresql://typed_sql:typed_sql@127.0.0.1:55432/typed_sql_benchmark",
  },
});
