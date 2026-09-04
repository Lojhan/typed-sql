import { describe, it, strict } from "poku";
import { insertionOffsets, sourceBindings } from "../src/source-mapping.js";

await describe("indexed source mapping", async () => {
  await it("preserves strict insertion boundaries, duplicate positions, and arbitrary lookup order", () => {
    const insertions = [
      { position: 0, length: 2 },
      { position: 4, length: 3 },
      { position: 4, length: 7 },
      { position: 20, length: 1 },
    ];
    const offset = insertionOffsets(insertions);
    for (const position of [20, 0, 4, 5, 21, 1, -1])
      strict.strictEqual(
        offset(position),
        insertions.reduce((sum, item) => sum + (item.position < position ? item.length : 0), 0),
      );
    strict.strictEqual(insertionOffsets([])(10), 0);
  });

  await it("retains declaration binding names and source spans across whitespace and boundaries", () => {
    const source =
      "export const first = sql`SELECT 1`;let second=sql`SELECT 2`;\nfunction f(){\n const third\n = \n sql`SELECT 3`;return sql`SELECT 4`;}\nconst $fifth = sql`SELECT 5`;";
    const bindings = sourceBindings(source);
    for (const match of source.matchAll(/sql`/gu)) {
      const prefix = source.slice(0, match.index);
      const previous = /(?:^|[;{}]\s*|\n\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(prefix);
      const binding = bindings.get(match.index);
      strict.strictEqual(binding?.name, previous?.[1]);
      if (binding !== undefined) strict.strictEqual(source.slice(binding.range.start, binding.range.end), binding.name);
    }
  });
});
