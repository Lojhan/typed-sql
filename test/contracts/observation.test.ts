import { describe, it, strict } from "poku";
import { compileSource } from "../../packages/compiler/src/index.js";
import type { DatabaseObserver, DatabaseOperationStart } from "../../packages/core/src/index.js";
import { type PostgresSchemaSnapshot, postgres, sql } from "../../packages/postgres/src/index.js";
import { createPostgresDatabase } from "../../packages/postgres/src/runtime.js";
import { loadSchemaSnapshot } from "../../packages/schema/src/index.js";

await describe("compiler and runtime observation correlation", async () => {
  await it("uses a structural variant fingerprint as the runtime query identity", async () => {
    const schema = (await loadSchemaSnapshot(
      fileURLToPath(new URL("../fixtures/success/schema.json", import.meta.url)),
    )) as PostgresSchemaSnapshot;
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      "const query = sql`SELECT id FROM users ${include ? sql.fragment`WHERE id = ${id}` : sql.empty}`;",
    ].join("\n");
    const compiled = compileSource({ source, schema, dialect: postgres() });
    strict.deepStrictEqual(compiled.diagnostics, []);
    strict.strictEqual(compiled.queries[0]?.variantFingerprints.length, 2);

    const starts: DatabaseOperationStart[] = [];
    const observer: DatabaseObserver = {
      start(operation) {
        starts.push(operation);
        return undefined;
      },
    };
    const database = createPostgresDatabase({
      observer,
      pool: {
        async query() {
          return { rows: [] };
        },
        async connect() {
          throw new Error("The correlation test does not lease a connection");
        },
        async end() {},
      },
    });
    await database.execute(sql`SELECT id FROM users ${sql.fragment`WHERE id = ${1}`}`);

    const operation = starts[0];
    if (operation?.kind !== "query") strict.fail("Expected a query observation");
    strict.ok(compiled.queries[0]?.variantFingerprints.includes(operation.fingerprint));
  });
});

import { fileURLToPath } from "node:url";
