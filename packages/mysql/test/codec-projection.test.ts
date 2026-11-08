import { describe, it, strict } from "poku";
import { mySqlCatalogType, mySqlCoreCatalog } from "../src/catalog/index.js";
import { mySqlCodecTypes } from "../src/codecs/generated/types.js";
import { mySqlCodecTypeMapping } from "../src/codecs/index.js";
import { MYSQL_SUPPORT_POLICY } from "../src/support.js";

await describe("MySQL runtime codec projection", async () => {
  await it("preserves every mapped name and alias in every declared series", () => {
    const series = [...MYSQL_SUPPORT_POLICY.stable, MYSQL_SUPPORT_POLICY.canary].map((profile) => profile.series);
    strict.deepEqual(Object.keys(mySqlCodecTypes), series);
    for (const selected of series) {
      const catalog = mySqlCoreCatalog(selected)!;
      const schema = { formatVersion: 1, dialect: "mysql", version: selected, tables: {} } as const;
      const names = new Set(catalog.types.flatMap((type) => [type.name, ...type.aliases]));
      strict.deepEqual(Object.keys(mySqlCodecTypes[selected]!).sort(), [...names].sort());
      for (const name of names)
        for (const spelling of [name, name.toUpperCase(), ` ${name} `, `${name}(20, 2)`, `${name} unsigned`])
          strict.equal(
            mySqlCodecTypeMapping(spelling, schema),
            mySqlCatalogType(spelling, schema)?.mapping,
            `${selected}: ${spelling}`,
          );
    }
  });
  await it("preserves missing versus unsupported version evidence and refuses inherited property names", () => {
    for (const version of [undefined, "unknown", "8.0", "99.0"]) {
      const schema = { formatVersion: 1, dialect: "mysql", tables: {}, ...(version ? { version } : {}) } as const;
      for (const name of ["bigint", "integer", "double precision", "decimal(10,2)", "constructor", "__proto__"])
        strict.equal(mySqlCodecTypeMapping(name, schema), mySqlCatalogType(name, schema)?.mapping);
    }
  });
});
