import { describe, it, strict } from "poku";
import {
  createDatabase,
  defineConfig,
  diagnosticRegistry,
  DIALECT_CONTRACT_VERSION,
  isTypedSqlDiagnosticCode,
  parameterTypeLiteral,
  renderQuery,
  rowTypeLiteral,
  sql,
  type DialectPlugin,
  type Query,
  type QueryParameters,
  type QueryRow,
  type SchemaSnapshot,
  type SqlFragment,
  type SqlRenderer,
} from "../src/index.js";

const renderer: SqlRenderer = {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

await describe("runtime SQL tag", async () => {
  await it("parameterizes ordinary values in order", async () => {
    const id = 42;
    const active = true;
    const query = sql`SELECT id FROM users WHERE id = ${id} AND active = ${active}`;
    strict.deepStrictEqual(renderQuery(query, renderer), {
      text: "SELECT id FROM users WHERE id = $1 AND active = $2",
      values: [42, true],
    });
  });

  await it("preserves an explicit ordered parameter tuple", () => {
    const query = sql<{ readonly id: number }, readonly [number, boolean]>
      `SELECT id FROM users WHERE id = ${42} AND active = ${true}`;
    const exact: Query<{ readonly id: number }, readonly [number, boolean]> = query;
    strict.deepStrictEqual(renderQuery(exact, renderer).values, [42, true]);

    // @ts-expect-error the first interpolation must match the declared number parameter
    sql<{ readonly id: number }, readonly [number]>`SELECT id FROM users WHERE id = ${"wrong"}`;
  });

  await it("quotes explicit identifiers and preserves nested parameter ordering", async () => {
    const columns = sql.join([sql.ident("id"), sql.ident('display"name')]);
    const query = sql`SELECT ${columns} FROM users WHERE id = ${sql.value(7)}`;
    strict.deepStrictEqual(renderQuery(query, renderer), {
      text: 'SELECT "id", "display""name" FROM users WHERE id = $1',
      values: [7],
    });
  });

  await it("provides an immutable empty structural fragment", () => {
    strict.deepStrictEqual(renderQuery(sql`SELECT 1${sql.empty}`, renderer), {
      text: "SELECT 1",
      values: [],
    });
    strict.ok(Object.isFrozen(sql.empty));
  });

  await it("composes nullable AND/OR filter lists without losing parameter types or order", () => {
    type Status = "active" | "suspended";
    type AccountRow = { readonly id: bigint; readonly status: Status };
    interface Filters {
      readonly status?: Status | null;
      readonly minimumId?: bigint | null;
    }

    const base = sql<AccountRow, readonly []>`SELECT account.id, account.status FROM accounts AS account`;
    const accounts = (filters: Filters, mode: "all" | "any") => {
      const predicates = [
        filters.status == null ? undefined : sql.fragment`account.status = ${filters.status}`,
        filters.minimumId == null ? undefined : sql.fragment`account.id >= ${filters.minimumId}`,
      ] as const;
      return sql.where(base, mode === "all" ? sql.and(predicates) : sql.or(predicates));
    };

    const both = accounts({ status: "active", minimumId: 10n }, "all");
    const exact: Query<AccountRow, readonly [Status, bigint]> = both;
    const exactParameters: Assert<Equal<QueryParameters<typeof both>, readonly [Status, bigint]>> = true;
    const row: QueryRow<typeof exact> = { id: 10n, status: "active" };
    const parameters: QueryParameters<typeof exact> = ["suspended", 11n];
    void row;
    void parameters;
    void exactParameters;
    strict.deepStrictEqual(renderQuery(exact, renderer), {
      text: "SELECT account.id, account.status FROM accounts AS account WHERE (account.status = $1) AND (account.id >= $2)",
      values: ["active", 10n],
    });

    strict.deepStrictEqual(renderQuery(accounts({ minimumId: 5n }, "any"), renderer), {
      text: "SELECT account.id, account.status FROM accounts AS account WHERE (account.id >= $1)",
      values: [5n],
    });
    strict.deepStrictEqual(renderQuery(accounts({}, "all"), renderer), {
      text: "SELECT account.id, account.status FROM accounts AS account WHERE TRUE",
      values: [],
    });
    strict.deepStrictEqual(renderQuery(accounts({}, "any"), renderer).text.endsWith(" WHERE TRUE"), true);

    // @ts-expect-error composed parameter order remains status followed by bigint
    const wrongParameters: QueryParameters<typeof exact> = [1n, "active"];
    void wrongParameters;
    strict.throws(() => sql.and([sql.raw("account.active"), "unsafe" as never]), /accepts SQL fragments/);
  });

  await it("appends optional filter fragments while preserving rows and renumbering values", () => {
    type Status = "active" | "suspended";
    type AccountRow = { readonly id: bigint; readonly email: string; readonly status: Status };
    interface AccountFilters {
      readonly status?: Status | null;
      readonly minimumId?: bigint | null;
    }

    const base = sql<AccountRow, readonly []>`SELECT account.id, account.email, account.status FROM users AS account WHERE 1 = 1`;
    const accounts = (filters: AccountFilters) => sql.append(
      base,
      filters.status == null ? undefined : sql.fragment` AND account.status = ${filters.status}`,
      filters.minimumId == null ? undefined : sql.fragment` AND account.id >= ${filters.minimumId}`,
    );

    const both = accounts({ status: "active", minimumId: 10n });
    const exact: Query<AccountRow, readonly [Status, bigint]> = both;
    const exactParameters: Assert<Equal<QueryParameters<typeof both>, readonly [Status, bigint]>> = true;
    void exactParameters;
    strict.deepStrictEqual(renderQuery(exact, renderer), {
      text: "SELECT account.id, account.email, account.status FROM users AS account WHERE 1 = 1 AND account.status = $1 AND account.id >= $2",
      values: ["active", 10n],
    });
    strict.deepStrictEqual(renderQuery(accounts({ minimumId: 5n }), renderer), {
      text: "SELECT account.id, account.email, account.status FROM users AS account WHERE 1 = 1 AND account.id >= $1",
      values: [5n],
    });
    strict.deepStrictEqual(renderQuery(accounts({}), renderer), {
      text: "SELECT account.id, account.email, account.status FROM users AS account WHERE 1 = 1",
      values: [],
    });

    const mutable: (SqlFragment<readonly [Status]> | SqlFragment<readonly [bigint]>)[] = [];
    mutable.push(sql.fragment` AND account.status = ${"active" as Status}`);
    mutable.push(sql.fragment` AND account.id >= ${10n}`);
    const mutableQuery = sql.append(base, ...mutable);
    const allowed: QueryParameters<typeof mutableQuery> = ["suspended", 11n];
    void allowed;

    // @ts-expect-error the optional fragments retain status followed by bigint
    const wrong: QueryParameters<typeof exact> = [10n, "active"];
    void wrong;
    strict.throws(() => sql.append(base, "unsafe" as never), /accepts SQL fragments/);
  });

  await it("executes typed query values through an adapter", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const db = createDatabase({
      async execute(text, values): Promise<readonly unknown[]> {
        calls.push({ text, values });
        return [{ id: 1 }];
      },
    }, renderer);
    const rows = await db.execute(sql<{ id: number }>`SELECT id FROM users`);
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    strict.strictEqual(calls[0]?.text, "SELECT id FROM users");
  });

  await it("keeps raw SQL explicit and validates identifier input", () => {
    strict.deepStrictEqual(renderQuery(sql.dynamic("SELECT 1"), renderer), { text: "SELECT 1", values: [] });
    strict.deepStrictEqual(renderQuery(sql`SELECT ${sql.raw("CURRENT_DATE")}`, renderer), {
      text: "SELECT CURRENT_DATE",
      values: [],
    });
    strict.throws(() => sql.ident(""), /non-empty/);
    strict.throws(() => sql.ident("bad\0name"), /NUL/);
  });

  await it("supports transaction executors and rejects missing transaction support", async () => {
    const executor = { async execute(): Promise<readonly unknown[]> { return [{ value: 2 }]; } };
    const db = createDatabase(executor, renderer, async (run) => run(executor));
    const value = await db.transaction(async (transaction) => (await transaction.execute(sql<{ value: number }>`SELECT 2 AS value`))[0]?.value);
    strict.strictEqual(value, 2);
    await strict.rejects(() => createDatabase(executor, renderer).transaction(async () => undefined), /does not support transactions/);
  });
});

await describe("core contracts", async () => {
  const schema = { formatVersion: 1, dialect: "test", tables: {} } satisfies SchemaSnapshot;
  const dialect: DialectPlugin<SchemaSnapshot, Record<string, never>> = {
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "test",
    grammarVersion: "1.0.0",
    sqlModule: "@example/typed-sql-test",
    defaultTypePolicy: {},
    placeholder: (index) => `?${index}`,
    analyze: () => ({ columns: [], parameters: [], diagnostics: [] }),
    validateSnapshot: () => schema,
  };

  await it("defines immutable typed configuration", () => {
    const config = defineConfig({ dialect, schema: { file: "schema.json" }, outDir: "generated" });
    strict.strictEqual(config.dialect, dialect);
    strict.ok(Object.isFrozen(config));
    strict.throws(() => defineConfig({
      dialect: { ...dialect, contractVersion: 3 as never },
      schema: { file: "schema.json" },
      outDir: "generated",
    }), /Unsupported typed-sql dialect contract/);
  });

  await it("publishes the stable diagnostic registry", () => {
    strict.strictEqual(diagnosticRegistry.TSQ301.category, "drift");
    strict.strictEqual(isTypedSqlDiagnosticCode("TSQ401"), true);
    strict.strictEqual(isTypedSqlDiagnosticCode("TSQ999"), false);
    strict.ok(Object.isFrozen(diagnosticRegistry));
  });

  await it("renders deterministic TypeScript row literals", () => {
    strict.strictEqual(rowTypeLiteral([
      { name: "id", tsType: "bigint", nullable: false, range: { start: 0, end: 1, line: 1, column: 1 } },
      { name: "display name", tsType: "string", nullable: true, range: { start: 2, end: 3, line: 1, column: 3 } },
    ]), '{ "id": bigint; "display name": string | null; }');
  });

  await it("renders ordered parameter tuples with unresolved positions", () => {
    strict.strictEqual(parameterTypeLiteral(4, [
      { index: 1, tsType: "bigint", nullable: false, databaseType: "int8" },
      { index: 3, tsType: '\"active\" | \"suspended\"', nullable: false },
      { index: 4, tsType: "string", nullable: true },
    ]), 'readonly [bigint, unknown, "active" | "suspended", string | null]');
  });
});
