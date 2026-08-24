import { defineConfig } from "poku";

export default defineConfig({
  include: ["test"],
  filter: /\.e2e\.test\.ts$/,
  isolation: "process",
  sequential: true,
  timeout: 180_000,
});
