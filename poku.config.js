import { defineConfig } from "poku";

export default defineConfig({
  include: ["packages"],
  filter: /\.test\.ts$/,
  exclude: /fixtures/,
  isolation: "process",
  timeout: 120_000,
});
