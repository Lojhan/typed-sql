import { describe, it, strict } from "poku";
import {
  introspectPostgres,
  loadPostgresDriver,
  type PostgresIntrospectionClient,
  type PostgresIntrospectionPool,
  PostgresSchemaProvider,
  type PostgresQueryable,
  type PostgresQueryResult,
} from "../src/provider.js";

class CatalogClient implements PostgresIntrospectionClient {
  readonly filters: unknown[] = [];
  readonly commands: string[] = [];
  released = false;
  failCatalog = false;
  failRollback = false;

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    this.commands.push(text);
    if (text === "ROLLBACK" && this.failRollback) throw new Error("rollback failed");
    if (this.failCatalog && text.includes("pg_catalog.pg_enum")) throw new Error("postgres://secret@localhost/db catalog failed");
    if (values !== undefined && values.length > 0) this.filters.push(values[0]);
    let rows: readonly Record<string, unknown>[];
    if (text === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" || text === "COMMIT" || text === "ROLLBACK") rows = [];
    else if (text.includes("server_version")) rows = [{ server_version: "18.1" }];
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

  release(): void { this.released = true; }
}

class CatalogPool implements PostgresIntrospectionPool {
  ended = false;

  constructor(readonly client: CatalogClient = new CatalogClient()) {}

  async connect(): Promise<PostgresIntrospectionClient> { return this.client; }
  async end(): Promise<void> { this.ended = true; }
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

  await it("runs URL introspection in a read-only transaction using an injected pool", async () => {
    const pool = new CatalogPool();
    const snapshot = await introspectPostgres(
      { url: "postgres://secret@localhost/db" },
      { pool, includeSchemas: [] },
    );
    strict.strictEqual(snapshot.version, "18.1");
    strict.strictEqual(pool.client.commands[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    strict.strictEqual(pool.client.commands.at(-1), "COMMIT");
    strict.strictEqual(pool.client.released, true);
    strict.strictEqual(pool.ended, true);
    strict.ok(pool.client.filters.every((filter) => JSON.stringify(filter) === "[]"));
  });

  await it("rejects missing URLs and redacts credentials while preserving catalog failures", async () => {
    await strict.rejects(() => new PostgresSchemaProvider().introspect({}), /requires SchemaInput\.url/);
    const pool = new CatalogPool();
    pool.client.failCatalog = true;
    pool.client.failRollback = true;
    await strict.rejects(
      () => new PostgresSchemaProvider({ pool }).introspect({ url: "postgres://secret@localhost/db" }),
      (error: unknown) => error instanceof Error
        && error.message.includes("[REDACTED_DATABASE_URL]")
        && !error.message.includes("secret"),
    );
    strict.ok(pool.client.commands.includes("ROLLBACK"));
    strict.strictEqual(pool.client.released, true);
    strict.strictEqual(pool.ended, true);
  });

  await it("closes pools and redacts connection failures", async () => {
    const pool: PostgresIntrospectionPool & { ended: boolean } = {
      ended: false,
      async connect(): Promise<PostgresIntrospectionClient> {
        throw new Error("could not reach postgres://secret@localhost/db");
      },
      async end(): Promise<void> { this.ended = true; },
    };
    await strict.rejects(
      () => introspectPostgres({ url: "postgres://secret@localhost/db" }, { pool }),
      (error: unknown) => error instanceof Error
        && error.message.includes("[REDACTED_DATABASE_URL]")
        && !error.message.includes("secret"),
    );
    strict.strictEqual(pool.ended, true);
  });

  await it("normalizes application-owned driver loading failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(() => loadPostgresDriver(async () => { throw missing; }), /pnpm add pg/);
    const unexpected = new Error("broken loader");
    await strict.rejects(() => loadPostgresDriver(async () => { throw unexpected; }), unexpected);
    strict.ok((await loadPostgresDriver()).Pool !== undefined);
  });
});
