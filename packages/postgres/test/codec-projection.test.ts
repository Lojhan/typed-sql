import { describe, it, strict } from "poku";
import { postgresCatalogTypeMapping, postgresCoreCatalog } from "../src/catalog/index.js";
import { postgresCodecTypeMapping } from "../src/codecs/index.js";
import { postgresCatalogRevisions, postgresCodecTypes } from "../src/codecs/types-data.js";
import { POSTGRES_SUPPORT_POLICY } from "../src/support.js";

await describe("PostgreSQL runtime codec projection", async () => {
  await it("preserves every declared version, native name, alias and catalog revision", () => {
    const majors = [...POSTGRES_SUPPORT_POLICY.stableMajors, POSTGRES_SUPPORT_POLICY.canary.major];
    strict.deepEqual(Object.keys(postgresCodecTypes).map(Number), majors);
    for (const major of majors) {
      const catalog = postgresCoreCatalog(major)!;
      const schema = { formatVersion: 1, dialect: "postgres", version: String(major), tables: {} } as const;
      strict.equal(postgresCatalogRevisions[major], catalog.revision);
      const names = new Set(catalog.types.flatMap((type) => [type.name, ...type.aliases]));
      strict.deepEqual(Object.keys(postgresCodecTypes[major]!).sort(), [...names].sort());
      for (const name of names)
        for (const spelling of [name, name.toUpperCase(), ` ${name} `, `${name}(20, 2)`, `${name}[]`])
          strict.equal(
            postgresCodecTypeMapping(spelling, schema),
            postgresCatalogTypeMapping(spelling, schema),
            `${major}: ${spelling}`,
          );
      for (const name of ["interval day to second", "constructor", "__proto__", "unknown_native_type"])
        strict.equal(postgresCodecTypeMapping(name, schema), postgresCatalogTypeMapping(name, schema));
    }
  });
  await it("preserves the conservative default selection when version evidence is absent or unsupported", () => {
    for (const version of [undefined, "unknown", "13", "99"]) {
      const schema = { formatVersion: 1, dialect: "postgres", tables: {}, ...(version ? { version } : {}) } as const;
      for (const type of postgresCoreCatalog(POSTGRES_SUPPORT_POLICY.stableMajors[0])!.types)
        strict.equal(postgresCodecTypeMapping(type.name, schema), postgresCatalogTypeMapping(type.name, schema));
    }
  });
});
