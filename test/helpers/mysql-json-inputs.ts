import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Query } from "@typed-sql/core";
import { createConnection } from "mysql2/promise";
import { strict } from "poku";
import { compileSource } from "../../packages/compiler/src/index.js";
import { mysql } from "../../packages/mysql/src/analysis.js";
import { createMySql2Database, mysql2 } from "../../packages/mysql/src/mysql2.js";
import { defaultMySqlTypePolicy } from "../../packages/mysql/src/type-policy.js";
import { serializeSchemaSnapshot } from "../../packages/schema/src/index.js";

interface Factories {
  insert(id: bigint, payload: unknown): Query<Record<string, unknown>>;
  read(id: bigint): Query<Record<string, unknown>>;
}

/** Execute compiled JSON bindings with the uppercase physical spelling supplied by DDL models. */
export async function assertMySqlJsonInputs(connectionUri: string, workspace: string): Promise<void> {
  const admin = await createConnection(connectionUri);
  const table = `typed_sql_json_${randomBytes(8).toString("hex")}`;
  const directory = await mkdtemp(join(workspace, ".typed-sql-mysql-json-"));
  let created = false;
  try {
    await admin.query(`CREATE TABLE ${table}(id BIGINT PRIMARY KEY,payload JSON NOT NULL)`);
    created = true;
    for (const [index, json] of (["unknown", "JsonValue", "string"] as const).entries()) {
      const typePolicy = { ...defaultMySqlTypePolicy, json };
      const dialect = mysql({ typePolicy });
      const introspected = await mysql2({ connectionUri, typePolicy }).introspect();
      const input = JSON.parse(serializeSchemaSnapshot(introspected));
      const relation = Object.values(
        input.relations as Record<string, { name: string; columns: Record<string, { databaseType: string }> }>,
      ).find((value) => value.name === table);
      if (relation === undefined) throw Error("JSON fixture relation missing");
      const column = Object.values(relation.columns).find((value) => value.databaseType.toLowerCase() === "json");
      if (column === undefined) throw Error("JSON fixture column missing");
      column.databaseType = "JSON";
      const schema = dialect.validateSnapshot(input);
      const source = [
        'import {sql} from "@typed-sql/mysql";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source is compiled before importing it.
        "export const insert=(id:bigint,payload:unknown)=>sql`INSERT INTO TABLE(id,payload) VALUES(${id},${sql.json(payload)})`;",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source is compiled before importing it.
        "export const read=(id:bigint)=>sql`SELECT payload FROM TABLE WHERE id=${id}`;",
      ]
        .join("\n")
        .replaceAll("TABLE", table);
      const compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
      strict.deepEqual(compiled.diagnostics, []);
      strict.equal(compiled.queries.length, 2);
      strict.equal(compiled.queries[0]?.valuePlan?.parameters[1]?.json?.shape.kind, "unknown");
      const file = join(directory, `${json}.mts`);
      await writeFile(file, compiled.transformedSource);
      const factories = (await import(pathToFileURL(file).href)) as Factories;
      const database = await createMySql2Database({ connectionUri, typePolicy });
      try {
        const payload = { nested: [1, true, null, "text"], label: "catalog input" };
        await database.execute(factories.insert(BigInt(index + 1), payload));
        const rows = await database.all(factories.read(BigInt(index + 1)));
        strict.equal(rows.length, 1);
        strict.deepEqual(json === "string" ? JSON.parse(String(rows[0]!.payload)) : rows[0]!.payload, payload);
        strict.throws(() => factories.insert(9n, { invalid: 1n }), /JSON/);
      } finally {
        await database.close();
      }
    }
  } finally {
    try {
      if (created) await admin.query(`DROP TABLE ${table}`);
    } finally {
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
