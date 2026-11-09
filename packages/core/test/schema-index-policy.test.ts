import { it, strict } from "poku";
import { ResolverSchemaIndex, type SchemaSnapshot } from "../src/index.js";

await it("isolates cached schema indexes by caller-owned identifier comparison", () => {
  const schema: SchemaSnapshot = {
    formatVersion: 1,
    dialect: "external",
    tables: {
      records: {
        name: "records",
        columns: {
          k: { name: "k", databaseType: "integer", tsType: "number", nullable: false },
          K: { name: "K", databaseType: "text", tsType: "string", nullable: false },
        },
      },
    },
  };
  const ascii = (value: string) => value.replace(/[A-Z]+/gu, (part) => part.toLowerCase());
  const exact = (value: string) => value;
  const index = ResolverSchemaIndex.for(schema, ascii);
  strict.equal(index, ResolverSchemaIndex.for(schema, ascii));
  strict.notEqual(index, ResolverSchemaIndex.for(schema));
  strict.notEqual(index, ResolverSchemaIndex.for(schema, exact));
  strict.equal(index.column(schema.tables.records!, "K")?.name, "k");
  strict.equal(index.column(schema.tables.records!, "K")?.name, "K");
  strict.equal(ResolverSchemaIndex.for(schema, exact).tables("RECORDS").length, 0);
});
