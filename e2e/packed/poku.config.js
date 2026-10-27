import { defineConfig } from "poku";

export default defineConfig({
  include: ["test"],
  filter: /\.e2e\.test\.ts$/,
  isolation: "process",
  sequential: true,
  timeout: process.env.TYPED_SQL_CONSUMER_SOURCE === "registry" ? 900_000 : 300_000,
});
