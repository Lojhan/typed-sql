import { describe, it, strict } from "poku";
import { calculateSchemaHash } from "../../schema/src/index.js";
import { fingerprintPostgresExpressionSql } from "../src/expression-evidence.js";
import {
  introspectPostgres,
  loadPostgresDriver,
  type PostgresIntrospectionClient,
  type PostgresIntrospectionPool,
  type PostgresQueryResult,
  PostgresSchemaProvider,
  postgresCatalogQueries,
} from "../src/provider.js";

class CatalogClient implements PostgresIntrospectionClient {
  readonly filters: unknown[] = [];
  readonly commands: string[] = [];
  released = false;
  failCatalog = false;
  failRollback = false;
  reverseRows = false;
  richRows = false;

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.commands.push(text);
    if (text === "ROLLBACK" && this.failRollback) throw new Error("rollback failed");
    if (this.failCatalog && text.includes("pg_catalog.pg_enum"))
      throw new Error("postgres://secret@localhost/db catalog failed");
    if (values !== undefined && values.length > 0) this.filters.push(values[0]);
    let rows: readonly Record<string, unknown>[];
    if (
      text === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
      text === "COMMIT" ||
      text === "ROLLBACK"
    )
      rows = [];
    else if (text.includes("server_version"))
      rows = [
        {
          server_version: "18.1",
          standard_conforming_strings: "on",
          search_path: '"$user", public',
          extensions: ["plpgsql:1.0"],
        },
      ];
    else if (text.includes("pg_catalog.pg_enum"))
      rows = [
        { schema_name: "public", type_name: "user_role", enum_label: "user", enum_position: 1 },
        { schema_name: "public", type_name: "user_role", enum_label: "admin", enum_position: 2 },
      ];
    else if (text.includes("t.typtype = 'd'"))
      rows = [
        {
          schema_name: "public",
          domain_name: "positive_int",
          database_type: "integer",
          not_null: true,
          type_identity: "pg:positive_int",
          check_expressions: ["VALUE > 0"],
        },
      ];
    else if (text.includes("pg_catalog.pg_constraint"))
      rows = [
        {
          schema_name: "public",
          table_name: "users",
          constraint_name: "users_pkey",
          constraint_type: "p",
          columns: ["id"],
          deferrable: false,
          initially_deferred: false,
          nulls_not_distinct: false,
          expression_based: false,
          predicate_expression: null,
        },
        {
          schema_name: "public",
          table_name: "users",
          constraint_name: "users_role_check",
          constraint_type: "c",
          columns: ["role"],
          deferrable: false,
          initially_deferred: false,
          expression_based: true,
          predicate_expression: "role IS NOT NULL",
        },
      ];
    else if (text.includes("FROM pg_catalog.pg_index AS i"))
      rows = [
        {
          schema_name: "public",
          table_name: "users",
          index_name: "users_role_idx",
          unique: false,
          method: "btree",
          key_columns: ["role"],
          key_expressions: [null],
          descending: [false],
          nulls_first: [false],
          operator_classes: ["enum_ops"],
          collations: [null],
          included_columns: ["id"],
          predicate_expression: "role IS NOT NULL",
          valid: true,
        },
      ];
    else if (text.includes("t.typtype = 'c'"))
      rows = [
        {
          schema_name: "public",
          type_name: "address",
          type_identity: "pg:address",
          field_name: "city",
          field_type_identity: "pg:25",
          field_database_type: "text",
          field_not_null: true,
          field_position: 1,
        },
      ];
    else if (text.includes("pg_catalog.pg_range"))
      rows = [
        {
          schema_name: "public",
          type_name: "int4range",
          type_identity: "pg:3904",
          database_type: "int4range",
          subtype_identity: "pg:23",
          multirange: false,
        },
      ];
    else if (text.includes("FROM pg_catalog.pg_class AS c"))
      rows = [
        {
          schema_name: "public",
          table_name: "users",
          relation_kind: "r",
          is_partition: false,
          partition_parent_schema: null,
          partition_parent_table: null,
          partition_strategy: null,
        },
      ];
    else if (text.includes("pg_catalog.pg_attribute"))
      rows = [
        {
          schema_name: "public",
          table_name: "users",
          column_name: "id",
          database_type: "positive_int",
          not_null: false,
          is_array: false,
          default_expression: "nextval('users_id_seq'::regclass)",
          column_position: 0,
          relation_kind: "r",
          type_identity: "pg:positive_int",
          generated_kind: "",
          identity_kind: "d",
          collation_name: null,
          insertable: true,
          updatable: true,
        },
        {
          schema_name: "public",
          table_name: "users",
          column_name: "role",
          database_type: "user_role",
          not_null: true,
          is_array: false,
          default_expression: null,
          column_position: 1,
          relation_kind: "r",
          type_identity: "pg:user_role",
        },
        {
          schema_name: "public",
          table_name: "users",
          column_name: "tags",
          database_type: "text[]",
          not_null: false,
          is_array: true,
          default_expression: null,
          column_position: 2,
          relation_kind: "r",
          type_identity: "pg:1009",
        },
        {
          schema_name: "public",
          table_name: "users",
          column_name: "budget",
          database_type: "numeric(14,2)",
          not_null: false,
          is_array: false,
          default_expression: null,
          column_position: 3,
          relation_kind: "r",
          type_identity: "pg:1700",
        },
        {
          schema_name: "public",
          table_name: "users",
          column_name: "display_name",
          database_type: "character varying(120)",
          not_null: true,
          is_array: false,
          default_expression: null,
          column_position: 4,
          relation_kind: "r",
          type_identity: "pg:1043",
        },
      ];
    else if (text.includes("pg_catalog.pg_proc"))
      rows = [
        {
          schema_name: "public",
          function_name: "user_count",
          argument_types: [],
          database_return_type: "bigint",
          set_returning: false,
          volatility: "s",
          routine_identity: "pg:routine:1",
          routine_kind: "f",
          argument_names: [],
          argument_modes: [],
          argument_defaults: 0,
          strict: false,
          parallel_safety: "s",
        },
        {
          schema_name: "analytics",
          function_name: "user_count",
          argument_types: [],
          database_return_type: "bigint",
          set_returning: false,
          volatility: "s",
          routine_identity: "pg:routine:2",
          routine_kind: "f",
          argument_names: [],
          argument_modes: [],
          argument_defaults: 0,
          strict: false,
          parallel_safety: "r",
        },
      ];
    else throw new Error("Unexpected catalog query");
    if (this.richRows && text.includes("server_version")) {
      rows = [{ server_version: "18.1" }];
    } else if (this.richRows && text.includes("t.typtype = 'd'")) {
      rows = [
        ...rows,
        {
          schema_name: "app",
          domain_name: "email",
          database_type: "text",
          not_null: false,
          type_identity: null,
          check_expressions: null,
        },
      ];
    } else if (this.richRows && text.includes("pg_catalog.pg_constraint")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          table_name: "users",
          constraint_name: "users_role_key",
          constraint_type: "u",
          columns: ["role"],
          deferrable: false,
          initially_deferred: false,
          nulls_not_distinct: null,
          expression_based: null,
          predicate_expression: undefined,
        },
        {
          schema_name: "public",
          table_name: "users",
          constraint_name: "users_parent_fk",
          constraint_type: "f",
          columns: ["id"],
          referenced_schema: null,
          referenced_table: null,
          referenced_columns: null,
          match_type: "f",
          update_action: "c",
          delete_action: "n",
          deferrable: true,
          initially_deferred: true,
          expression_based: false,
          predicate_expression: null,
        },
        {
          schema_name: "public",
          table_name: "users",
          constraint_name: "users_exclude",
          constraint_type: "x",
          columns: [],
          exclusion_operators: ["="],
          deferrable: false,
          initially_deferred: false,
          expression_based: true,
          predicate_expression: "id > 0",
        },
        {
          schema_name: "public",
          table_name: "missing",
          constraint_name: "ignored",
          constraint_type: "p",
          columns: ["id"],
          deferrable: false,
          initially_deferred: false,
          predicate_expression: null,
        },
      ];
    } else if (this.richRows && text.includes("FROM pg_catalog.pg_index AS i")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          table_name: "users",
          index_name: "users_expression_idx",
          unique: true,
          method: "hash",
          key_columns: [null],
          key_expressions: [null],
          descending: [true],
          nulls_first: [true],
          operator_classes: [null],
          collations: ["C"],
          included_columns: [],
          predicate_expression: null,
          valid: false,
        },
        {
          schema_name: "public",
          table_name: "missing",
          index_name: "ignored",
          unique: false,
          key_columns: [],
          key_expressions: [],
          descending: [],
          nulls_first: [],
          operator_classes: [],
          collations: [],
          included_columns: [],
          predicate_expression: null,
          valid: true,
        },
      ];
    } else if (this.richRows && text.includes("t.typtype = 'c'")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          type_name: "address",
          type_identity: "pg:address",
          field_name: "zip",
          field_type_identity: "pg:23",
          field_database_type: "integer",
          field_not_null: false,
          field_position: 2,
        },
      ];
    } else if (this.richRows && text.includes("pg_catalog.pg_range")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          type_name: "int4multirange",
          type_identity: "pg:4451",
          database_type: "int4multirange",
          subtype_identity: "pg:23",
          multirange: true,
        },
      ];
    } else if (this.richRows && text.includes("FROM pg_catalog.pg_class AS c")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          table_name: "generated_users",
          relation_kind: "v",
          is_partition: false,
          partition_parent_schema: null,
          partition_parent_table: null,
          partition_strategy: null,
        },
        {
          schema_name: "public",
          table_name: "materialized_users",
          relation_kind: "m",
          is_partition: false,
          partition_parent_schema: null,
          partition_parent_table: null,
          partition_strategy: null,
        },
        {
          schema_name: "public",
          table_name: "foreign_users",
          relation_kind: "f",
          is_partition: false,
          partition_parent_schema: null,
          partition_parent_table: null,
          partition_strategy: null,
        },
        {
          schema_name: "public",
          table_name: "partitioned_users",
          relation_kind: "p",
          is_partition: false,
          partition_parent_schema: null,
          partition_parent_table: null,
          partition_strategy: "r",
        },
        {
          schema_name: "public",
          table_name: "users_2026",
          relation_kind: "r",
          is_partition: true,
          partition_parent_schema: "public",
          partition_parent_table: "partitioned_users",
          partition_strategy: null,
        },
        {
          schema_name: "public",
          table_name: "zero_column_table",
          relation_kind: "r",
          is_partition: false,
          partition_parent_schema: null,
          partition_parent_table: null,
          partition_strategy: null,
        },
      ];
    } else if (this.richRows && text.includes("pg_catalog.pg_attribute")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          table_name: "generated_users",
          column_name: "computed",
          database_type: "mystery",
          not_null: false,
          is_array: false,
          default_expression: "id + 1",
          column_position: null,
          relation_kind: "v",
          type_identity: null,
          generated_kind: "s",
          identity_kind: "a",
          collation_name: "C",
        },
        {
          schema_name: "public",
          table_name: "materialized_users",
          column_name: "id",
          database_type: "integer",
          not_null: true,
          is_array: false,
          default_expression: null,
          column_position: 0,
          relation_kind: "m",
          generated_kind: "",
          identity_kind: "",
        },
        {
          schema_name: "public",
          table_name: "foreign_users",
          column_name: "id",
          database_type: "integer",
          not_null: true,
          is_array: false,
          default_expression: null,
          column_position: 0,
          relation_kind: "f",
          generated_kind: "",
          identity_kind: "",
        },
        {
          schema_name: "public",
          table_name: "partitioned_users",
          column_name: "id",
          database_type: "integer",
          not_null: true,
          is_array: false,
          default_expression: null,
          column_position: 0,
          relation_kind: "p",
          generated_kind: "",
          identity_kind: "",
          partition_strategy: "r",
        },
        {
          schema_name: "public",
          table_name: "users_2026",
          column_name: "id",
          database_type: "integer",
          not_null: true,
          is_array: false,
          default_expression: null,
          column_position: 0,
          relation_kind: "r",
          generated_kind: "",
          identity_kind: "",
          is_partition: true,
          partition_parent_schema: "public",
          partition_parent_table: "partitioned_users",
        },
      ];
    } else if (this.richRows && text.includes("pg_catalog.pg_proc")) {
      rows = [
        ...rows,
        {
          schema_name: "public",
          function_name: "table_result",
          argument_types: ["bigint", "text", "bigint"],
          database_return_type: "record",
          set_returning: true,
          volatility: "i",
          routine_identity: "pg:routine:3",
          routine_kind: "w",
          argument_names: [null, "label", null],
          argument_modes: ["o", "b", "v"],
          argument_defaults: 1,
          strict: true,
          parallel_safety: "s",
        },
        {
          schema_name: "public",
          function_name: "refresh_users",
          argument_types: [],
          database_return_type: "void",
          set_returning: false,
          volatility: "v",
          routine_identity: null,
          routine_kind: "p",
          strict: undefined,
          parallel_safety: "u",
        },
        {
          schema_name: "public",
          function_name: "user_count",
          argument_types: ["anyelement"],
          database_return_type: "anyelement",
          set_returning: false,
          volatility: "v",
          routine_identity: "pg:routine:4",
          routine_kind: "a",
          argument_modes: ["i"],
          argument_defaults: 0,
          strict: false,
          parallel_safety: "r",
        },
      ];
    }
    return { rows: (this.reverseRows ? [...rows].reverse() : rows) as readonly Row[] };
  }

  release(): void {
    this.released = true;
  }
}

class CatalogPool implements PostgresIntrospectionPool {
  ended = false;

  constructor(readonly client: CatalogClient = new CatalogClient()) {}

  async connect(): Promise<PostgresIntrospectionClient> {
    return this.client;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("PostgreSQL schema provider", async () => {
  await it("canonicalizes server-deparsed expression evidence before hashing", () => {
    strict.strictEqual(fingerprintPostgresExpressionSql("((age > 0))"), fingerprintPostgresExpressionSql("age>0"));
    strict.notStrictEqual(fingerprintPostgresExpressionSql("age > 0"), fingerprintPostgresExpressionSql("age > 1"));
    strict.strictEqual(fingerprintPostgresExpressionSql("("), fingerprintPostgresExpressionSql("("));
  });

  await it("introspects tables, defaults, enums, domains, functions, and version", async () => {
    const client = new CatalogClient();
    const provider = new PostgresSchemaProvider({ client, includeSchemas: ["public"] });
    const snapshot = await provider.introspect({});

    strict.strictEqual(snapshot.formatVersion, 2);
    strict.strictEqual(snapshot.version, "18.1");
    strict.deepStrictEqual(snapshot.server?.features, ["plpgsql:1.0"]);
    strict.deepStrictEqual(snapshot.server?.settings, {
      searchPath: '"$user", public',
      standardConformingStrings: "on",
      visibilityScope: "current-role",
    });
    strict.deepStrictEqual(snapshot.enums?.user_role, ["user", "admin"]);
    strict.strictEqual(snapshot.domains?.positive_int?.tsType, "number");
    strict.strictEqual(snapshot.tables.users?.columns.id?.nullable, false);
    strict.match(snapshot.relations.users?.columns.id?.defaultExpressionHash ?? "", /^sha256:/u);
    strict.strictEqual(snapshot.relations.users?.columns.id?.identity, "by-default");
    strict.strictEqual(snapshot.relations.users?.kind, "table");
    strict.strictEqual(snapshot.tables.users?.columns.role?.tsType, '"user" | "admin"');
    strict.strictEqual(snapshot.tables.users?.columns.tags?.tsType, "readonly (string)[]");
    strict.strictEqual(snapshot.tables.users?.columns.tags?.array, true);
    strict.strictEqual(snapshot.tables.users?.columns.budget?.tsType, "string");
    strict.strictEqual(snapshot.tables.users?.columns.display_name?.tsType, "string");
    strict.strictEqual(snapshot.functions?.["public.user_count()"]?.returnType, "bigint");
    strict.strictEqual(snapshot.functions?.["public.user_count()"]?.volatility, "stable");
    strict.strictEqual(snapshot.functions?.["analytics.user_count()"]?.returnType, "bigint");
    strict.strictEqual(snapshot.types.positive_int?.kind, "domain");
    strict.strictEqual(snapshot.types.address?.kind, "composite");
    strict.strictEqual(snapshot.types.int4range?.kind, "range");
    strict.deepStrictEqual(
      snapshot.relations.users?.constraints.map(({ kind }) => kind),
      ["primary-key", "check"],
    );
    strict.strictEqual(snapshot.relations.users?.indexes[0]?.includedColumns?.[0], "id");
    strict.strictEqual(snapshot.routines.user_count?.[0]?.dataAccess, "unknown");
    strict.strictEqual(snapshot.routines.user_count?.[0]?.extension?.attributes.parallelSafety, "safe");
    strict.strictEqual(snapshot.extension?.attributes.evidenceScope, "current-role");
    strict.ok(client.filters.every((filter) => JSON.stringify(filter) === '["public"]'));
  });

  await it("applies introspection type policy", async () => {
    const provider = new PostgresSchemaProvider({
      client: new CatalogClient(),
      typePolicy: {
        bigint: "string",
        numeric: "number",
        date: "string",
        json: "string",
        enums: "string",
        unknown: "never",
      },
    });
    const snapshot = await provider.introspect({});
    strict.strictEqual(snapshot.tables.users?.columns.role?.tsType, "string");
    strict.strictEqual(snapshot.functions?.["public.user_count()"]?.returnType, "string");
  });

  await it("maps complete structural catalog evidence conservatively", async () => {
    const client = new CatalogClient();
    client.richRows = true;
    const snapshot = await new PostgresSchemaProvider({ client }).introspect({});
    strict.strictEqual(snapshot.server.settings.standardConformingStrings, undefined);
    strict.strictEqual(snapshot.types["app.email"]?.kind, "domain");
    strict.strictEqual(snapshot.types.int4multirange?.kind, "multirange");
    strict.strictEqual(snapshot.types.mystery?.kind, "opaque");
    strict.strictEqual(snapshot.relations.generated_users?.kind, "view");
    strict.strictEqual(snapshot.relations.generated_users?.columns.computed?.generated, "stored");
    strict.strictEqual(snapshot.relations.materialized_users?.kind, "materialized-view");
    strict.strictEqual(snapshot.relations.foreign_users?.kind, "foreign-table");
    strict.deepStrictEqual(snapshot.relations.partitioned_users?.capabilities, {
      partitioned: true,
      partitionStrategy: "range",
    });
    strict.deepStrictEqual(snapshot.relations.users_2026?.capabilities, {
      partition: true,
      partitionParent: "partitioned_users",
    });
    strict.deepStrictEqual(snapshot.relations.zero_column_table?.columns, {});
    strict.ok(snapshot.relations.users?.constraints.some(({ kind }) => kind === "foreign-key"));
    strict.ok(snapshot.relations.users?.constraints.some(({ kind }) => kind === "exclusion"));
    strict.ok(snapshot.relations.users?.indexes.some(({ columns }) => columns[0]?.expressionHash !== undefined));
    strict.strictEqual(snapshot.routines.table_result?.[0]?.result.kind, "table");
    strict.strictEqual(snapshot.routines.refresh_users?.[0]?.result.kind, "command");
    strict.strictEqual(snapshot.routines.user_count?.length, 2);
    strict.strictEqual(snapshot.routines.user_count?.[1]?.polymorphicFamily, "postgres-anyelement");
    strict.strictEqual(snapshot.routines.table_result?.[0]?.extension?.attributes.parallelSafety, "safe");
  });

  await it("is canonical across shuffled catalog row order and version-safe catalog branches", async () => {
    const ordered = new CatalogClient();
    const shuffled = new CatalogClient();
    shuffled.reverseRows = true;
    const first = await new PostgresSchemaProvider({ client: ordered }).introspect({});
    const second = await new PostgresSchemaProvider({ client: shuffled }).introspect({});
    strict.strictEqual(calculateSchemaHash(first), calculateSchemaHash(second));
    strict.ok(!postgresCatalogQueries.constraints(14).includes("i.indnullsnotdistinct AS nulls_not_distinct"));
    strict.ok(postgresCatalogQueries.constraints(15).includes("i.indnullsnotdistinct AS nulls_not_distinct"));
    strict.ok(postgresCatalogQueries.columns.includes("& 8) = 8"));
    strict.ok(postgresCatalogQueries.relations.includes("pg_catalog.pg_partitioned_table"));
    strict.ok(postgresCatalogQueries.functions.includes("p.proparallel AS parallel_safety"));
  });

  await it("runs URL introspection in a read-only transaction using an injected pool", async () => {
    const pool = new CatalogPool();
    const snapshot = await introspectPostgres({ url: "postgres://secret@localhost/db" }, { pool, includeSchemas: [] });
    strict.strictEqual(snapshot.version, "18.1");
    strict.strictEqual(pool.client.commands[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    strict.strictEqual(pool.client.commands.at(-1), "COMMIT");
    strict.strictEqual(pool.client.released, true);
    strict.strictEqual(pool.ended, true);

    const rollbackPool = new CatalogPool();
    rollbackPool.client.failCatalog = true;
    await strict.rejects(() => new PostgresSchemaProvider({ pool: rollbackPool }).introspect({ url: "postgres://db" }));
    strict.ok(rollbackPool.client.commands.includes("ROLLBACK"));
    strict.strictEqual(rollbackPool.client.released, true);
    strict.strictEqual(rollbackPool.ended, true);
    strict.ok(pool.client.filters.every((filter) => JSON.stringify(filter) === "[]"));
  });

  await it("rejects missing URLs and redacts credentials while preserving catalog failures", async () => {
    await strict.rejects(() => new PostgresSchemaProvider().introspect({}), /requires SchemaInput\.url/);
    const pool = new CatalogPool();
    pool.client.failCatalog = true;
    pool.client.failRollback = true;
    await strict.rejects(
      () => new PostgresSchemaProvider({ pool }).introspect({ url: "postgres://secret@localhost/db" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("[REDACTED_DATABASE_URL]") &&
        !error.message.includes("secret"),
    );
    strict.ok(pool.client.commands.includes("ROLLBACK"));
    strict.strictEqual(pool.client.released, true);
    strict.strictEqual(pool.ended, true);

    const nonErrorPool: PostgresIntrospectionPool & { ended: boolean } = {
      ended: false,
      async connect(): Promise<PostgresIntrospectionClient> {
        throw "connection unavailable";
      },
      async end(): Promise<void> {
        this.ended = true;
      },
    };
    await strict.rejects(
      () => introspectPostgres({ url: "postgres://secret@localhost/db" }, { pool: nonErrorPool }),
      /connection unavailable/,
    );
    strict.strictEqual(nonErrorPool.ended, true);
  });

  await it("closes pools and redacts connection failures", async () => {
    const pool: PostgresIntrospectionPool & { ended: boolean } = {
      ended: false,
      async connect(): Promise<PostgresIntrospectionClient> {
        throw new Error("could not reach postgres://secret@localhost/db");
      },
      async end(): Promise<void> {
        this.ended = true;
      },
    };
    await strict.rejects(
      () => introspectPostgres({ url: "postgres://secret@localhost/db" }, { pool }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("[REDACTED_DATABASE_URL]") &&
        !error.message.includes("secret"),
    );
    strict.strictEqual(pool.ended, true);
  });

  await it("normalizes application-owned driver loading failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(
      () =>
        loadPostgresDriver(async () => {
          throw missing;
        }),
      /pnpm add pg/,
    );
    const unexpected = new Error("broken loader");
    await strict.rejects(
      () =>
        loadPostgresDriver(async () => {
          throw unexpected;
        }),
      unexpected,
    );
    strict.ok((await loadPostgresDriver()).Pool !== undefined);
  });
});
