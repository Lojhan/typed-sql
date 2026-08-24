export { sql, createDatabase } from "../../../../../packages/runtime/src/index.js";
import { createDatabase } from "../../../../../packages/runtime/src/index.js";

export const db = createDatabase({
  async execute(): Promise<readonly unknown[]> {
    return [];
  },
});
