import { describe, it, strict } from "poku";
import {
  PostgresSchemaProvider,
  type PostgresQueryable,
  type PostgresQueryResult,
} from "../packages/schema/src/index.js";

class CatalogClient implements PostgresQueryable {
  readonly filters: unknown[] = [];

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    if (values !== undefined) this.filters.push(values[0]);
    let rows: readonly Record<string, unknown>[];
    if (text.includes("server_version")) rows = [{ server_version: "18.1" }];
    else if (text.includes("pg_catalog.pg_enum")) rows = [
      { schema_name: "public", type_name: "user_role", enum_label: "user" },
      { schema_name: "public", type_name: "user_role", enum_label: "admin" },
    ];
    else if (text.includes("t.typtype = 'd'")) rows = [
      { schema_name: "public", domain_name: "positive_int", database_type: "integer", not_null: true },
    ];
    else if (text.includes("pg_catalog.pg_attribute")) rows = [
      { schema_name: "public", table_name: "users", column_name: "id", database_type: "positive_int", not_null: false, is_array: false, default_expression: "nextval('users_id_seq'::regclass)" },
      { schema_name: "public", table_name: "users", column_name: "role", database_type: "user_role", not_null: true, is_array: false, default_expression: null },
      { schema_name: "public", table_name: "users", column_name: "tags", database_type: "text[]", not_null: false, is_array: true, default_expression: null },
      { schema_name: "public", table_name: "users", column_name: "budget", database_type: "numeric(14,2)", not_null: false, is_array: false, default_expression: null },
      { schema_name: "public", table_name: "users", column_name: "display_name", database_type: "character varying(120)", not_null: true, is_array: false, default_expression: null },
    ];
    else if (text.includes("pg_catalog.pg_proc")) rows = [
      { schema_name: "public", function_name: "user_count", argument_types: [], database_return_type: "bigint", set_returning: false },
    ];
    else throw new Error("Unexpected catalog query");
    return { rows: rows as readonly Row[] };
  }
}

await describe("PostgreSQL schema provider", async () => {
  await it("introspects tables, defaults, enums, domains, functions, and version", async () => {
    const client = new CatalogClient();
    const provider = new PostgresSchemaProvider({ client, includeSchemas: ["public"] });
    const snapshot = await provider.introspect({});

    strict.strictEqual(snapshot.version, "18.1");
    strict.deepStrictEqual(snapshot.enums?.user_role, ["user", "admin"]);
    strict.strictEqual(snapshot.domains?.positive_int?.tsType, "number");
    strict.strictEqual(snapshot.tables.users?.columns.id?.nullable, false);
    strict.strictEqual(snapshot.tables.users?.columns.id?.defaultExpression, "nextval('users_id_seq'::regclass)");
    strict.strictEqual(snapshot.tables.users?.columns.role?.tsType, '"user" | "admin"');
    strict.strictEqual(snapshot.tables.users?.columns.tags?.tsType, "readonly (string)[]");
    strict.strictEqual(snapshot.tables.users?.columns.tags?.array, true);
    strict.strictEqual(snapshot.tables.users?.columns.budget?.tsType, "string");
    strict.strictEqual(snapshot.tables.users?.columns.display_name?.tsType, "string");
    strict.strictEqual(snapshot.functions?.["user_count()"]?.returnType, "bigint");
    strict.ok(client.filters.every((filter) => JSON.stringify(filter) === '["public"]'));
  });

  await it("applies introspection type policy", async () => {
    const provider = new PostgresSchemaProvider({
      client: new CatalogClient(),
      typePolicy: { bigint: "string", numeric: "number", date: "string", json: "string", enums: "string", unknown: "never" },
    });
    const snapshot = await provider.introspect({});
    strict.strictEqual(snapshot.tables.users?.columns.role?.tsType, "string");
    strict.strictEqual(snapshot.functions?.["user_count()"]?.returnType, "string");
  });
});
