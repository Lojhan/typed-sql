import { defineConfig } from "poku";
export default defineConfig({ include: ["test"], filter: /\.test\.mjs$/, isolation: "process", timeout: 1200000 });
