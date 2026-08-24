export { sql } from "../../../../../packages/core/src/index.js";
import { createDatabase } from "../../../../../packages/core/src/index.js";

export const db = createDatabase({
  async execute(): Promise<readonly unknown[]> {
    return [];
  },
}, {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
});
