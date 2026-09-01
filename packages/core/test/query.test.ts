import { describe, it, strict } from "poku";
import {
  assertDialectPlugin,
  bindQueryRenderSkeleton,
  type ControlledQueryExecutor,
  closestName,
  compileQueryRenderSkeleton,
  createDatabase,
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  defineConfig,
  diagnosticRegistry,
  isTypedSqlDiagnosticCode,
  ParameterCollector,
  parameterTypeLiteral,
  type Query,
  QueryCardinalityError,
  type QueryParameters,
  type QueryRow,
  ResolverSchemaIndex,
  renderQuery,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SqlFragment,
  type SqlRenderer,
  sql,
  UnsupportedExecutionCapabilityError,
  unionTypeLiterals,
  unknownQuerySemantics,
} from "../src/index.js";

const renderer: SqlRenderer = {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
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

  await it("reuses immutable template text segments without sharing bound values", () => {
    const accountById = (id: number) => sql`SELECT id FROM account WHERE id = ${id}`;
    const first = accountById(1);
    const second = accountById(2);

    strict.strictEqual(first.segments.length, 3);
    strict.strictEqual(second.segments.length, 3);
    strict.strictEqual(first.segments[0], second.segments[0]);
    strict.strictEqual(first.segments[2], second.segments[2]);
    strict.notStrictEqual(first.segments[1], second.segments[1]);
    strict.ok(Object.isFrozen(first.segments[0]));
    strict.deepStrictEqual(renderQuery(first, renderer).values, [1]);
    strict.deepStrictEqual(renderQuery(second, renderer).values, [2]);
  });

  await it("interns immutable static fragments but keeps query identity isolated", () => {
    const staticQuery = () => sql`SELECT id FROM account`;
    const staticFragment = () => sql.fragment`ORDER BY id`;

    strict.notStrictEqual(staticQuery(), staticQuery());
    strict.strictEqual(staticFragment(), staticFragment());
    strict.ok(Object.isFrozen(staticQuery().segments));
    strict.ok(Object.isFrozen(staticFragment().segments));
  });

  await it("rebinds stable query skeletons without repeating structural rendering", () => {
    let placeholderCalls = 0;
    let identifierCalls = 0;
    const observedRenderer: SqlRenderer = {
      placeholder(index) {
        placeholderCalls += 1;
        return `$${index}`;
      },
      quoteIdentifier(name) {
        identifierCalls += 1;
        return `"${name}"`;
      },
    };
    const compiled = compileQueryRenderSkeleton(
      sql`SELECT ${sql.ident("id")} FROM users WHERE id = ${1}`,
      observedRenderer,
    );

    strict.deepStrictEqual(compiled.rendered, {
      text: 'SELECT "id" FROM users WHERE id = $1',
      values: [1],
    });
    strict.deepStrictEqual(
      bindQueryRenderSkeleton(sql`SELECT ${sql.ident("id")} FROM users WHERE id = ${2}`, compiled.skeleton),
      { text: 'SELECT "id" FROM users WHERE id = $1', values: [2] },
    );
    strict.deepStrictEqual([placeholderCalls, identifierCalls], [1, 1]);
    strict.ok(Object.isFrozen(compiled.skeleton));

    strict.strictEqual(
      bindQueryRenderSkeleton(sql`SELECT ${sql.ident("email")} FROM users WHERE id = ${2}`, compiled.skeleton),
      undefined,
    );
    strict.strictEqual(
      bindQueryRenderSkeleton(sql`SELECT ${sql.ident("id")} FROM accounts WHERE id = ${2}`, compiled.skeleton),
      undefined,
    );
    strict.strictEqual(
      bindQueryRenderSkeleton(sql`SELECT ${sql.ident("id")} FROM users WHERE id = ${sql.raw("$1")}`, compiled.skeleton),
      undefined,
    );
    strict.strictEqual(
      bindQueryRenderSkeleton(
        sql`SELECT ${sql.ident("id")} FROM users WHERE id = ${2} AND active = ${true}`,
        compiled.skeleton,
      ),
      undefined,
    );
    strict.deepStrictEqual([placeholderCalls, identifierCalls], [1, 1]);
  });

  await it("keeps hostile strings parameterized inside trusted structural fragments", () => {
    const hostile = "' OR TRUE; DROP TABLE users; --";
    const predicate = sql.fragment` AND users.name = ${hostile}`;
    strict.deepStrictEqual(renderQuery(sql`SELECT id FROM users WHERE TRUE${predicate}`, renderer), {
      text: "SELECT id FROM users WHERE TRUE AND users.name = $1",
      values: [hostile],
    });
  });

  await it("preserves an explicit ordered parameter tuple", () => {
    const query = sql<
      { readonly id: number },
      readonly [number, boolean]
    >`SELECT id FROM users WHERE id = ${42} AND active = ${true}`;
    const exact: Query<{ readonly id: number }, readonly [number, boolean]> = query;
    strict.deepStrictEqual(renderQuery(exact, renderer).values, [42, true]);

    // @ts-expect-error the first interpolation must match the declared number parameter
    sql<{ readonly id: number }, readonly [number]>`SELECT id FROM users WHERE id = ${"wrong"}`;

    const overlaid = sql.__typed<{ readonly id: number }, readonly [number]>()`SELECT id FROM users WHERE id = ${42}`;
    const overlaidParameters: Assert<Equal<QueryParameters<typeof overlaid>, readonly [number]>> = true;
    void overlaidParameters;
    // @ts-expect-error compiler overlays validate the complete flattened parameter tuple
    sql.__typed<{ readonly id: number }, readonly [number]>()`SELECT id FROM users WHERE id = ${"wrong"}`;
  });

  await it("quotes explicit identifiers and preserves nested parameter ordering", async () => {
    const columns = sql.join([sql.ident("id"), sql.ident('display"name')]);
    const query = sql`SELECT ${columns} FROM users WHERE id = ${sql.value(7)}`;
    strict.deepStrictEqual(renderQuery(query, renderer), {
      text: 'SELECT "id", "display""name" FROM users WHERE id = $1',
      values: [7],
    });
    const union = sql.join([sql.raw("SELECT 1"), sql.raw("SELECT 2")], sql.raw(" UNION ALL "));
    strict.strictEqual(renderQuery(sql`${union}`, renderer).text, "SELECT 1 UNION ALL SELECT 2");
    strict.throws(
      () => sql.join([sql.raw("SELECT 1")], " unsafe " as never),
      /separator must be a trusted SQL fragment/,
    );
    strict.throws(() => sql.join(["unsafe" as never]), /accepts SQL fragments/);
  });

  await it("provides an immutable empty structural fragment", () => {
    strict.deepStrictEqual(renderQuery(sql`SELECT 1${sql.empty}`, renderer), {
      text: "SELECT 1",
      values: [],
    });
    strict.ok(Object.isFrozen(sql.empty));
  });

  await it("recognizes fragments created by another installed core copy", () => {
    const foreign = Object.freeze({
      [Symbol.for("@typed-sql/core.fragment")]: () => [] as const,
      segments: Object.freeze([{ kind: "text", text: " FROM shared_runtime" }] as const),
    }) as unknown as SqlFragment<readonly []>;
    strict.deepStrictEqual(renderQuery(sql`SELECT 1${foreign}`, renderer), {
      text: "SELECT 1 FROM shared_runtime",
      values: [],
    });
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

    const base = sql<
      AccountRow,
      readonly []
    >`SELECT account.id, account.email, account.status FROM users AS account WHERE 1 = 1`;
    const accounts = (filters: AccountFilters) =>
      sql.append(
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
    const db = createDatabase(
      {
        async execute(text, values): Promise<readonly unknown[]> {
          calls.push({ text, values });
          return [{ id: 1 }];
        },
      },
      renderer,
    );
    const rows = await db.execute(sql<{ id: number }>`SELECT id FROM users`);
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    strict.strictEqual(calls[0]?.text, "SELECT id FROM users");
    strict.deepStrictEqual(db.executionCapabilities, { cancellation: false, deadlines: false });
    strict.ok(Object.isFrozen(db.executionCapabilities));
  });

  await it("preserves row types across all cardinality methods", async () => {
    type Account = { readonly id: bigint };
    const query = sql<Account>`SELECT id FROM account`;
    const database = createDatabase(
      {
        async execute() {
          return [{ id: 1n }];
        },
      },
      renderer,
    );
    const all: readonly Account[] = await database.all(query);
    const one: Account = await database.one(query);
    const maybe: Account | undefined = await database.maybeOne(query);
    strict.deepStrictEqual([all, one, maybe], [[{ id: 1n }], { id: 1n }, { id: 1n }]);
  });

  await it("uses stable cardinality errors without rewriting SQL", async () => {
    const database = createDatabase(
      {
        async execute() {
          return [];
        },
      },
      renderer,
    );
    const query = sql<{ readonly id: number }>`SELECT id FROM account`;
    await strict.rejects(database.one(query), (error: unknown) => {
      if (!(error instanceof QueryCardinalityError)) return false;
      strict.deepStrictEqual(
        { name: error.name, code: error.code, expected: error.expected, actual: error.actual },
        { name: "QueryCardinalityError", code: "TSQL_CARDINALITY", expected: "one", actual: 0 },
      );
      return true;
    });

    const many = createDatabase(
      {
        async execute() {
          return [{ id: 1 }, { id: 2 }];
        },
      },
      renderer,
    );
    await strict.rejects(many.maybeOne(query), (error: unknown) => {
      if (!(error instanceof QueryCardinalityError)) return false;
      strict.deepStrictEqual([error.expected, error.actual], ["maybeOne", 2]);
      return true;
    });
  });

  await it("negotiates execution controls explicitly and keeps execute on the thin path", async () => {
    const calls: string[] = [];
    const executor: ControlledQueryExecutor = {
      executionCapabilities: Object.freeze({ cancellation: true, deadlines: true }),
      async execute() {
        calls.push("execute");
        return [{ id: 1 }];
      },
      async executeControlled(_text, _values, options) {
        calls.push(options.deadline === undefined ? "signal" : "deadline");
        return [{ id: 1 }];
      },
    };
    const database = createDatabase(executor, renderer);
    const query = sql<{ readonly id: number }>`SELECT id FROM account`;
    await database.execute(query);
    await database.all(query);
    await database.all(query, { signal: new AbortController().signal });
    await database.one(query, { deadline: Date.now() + 1_000 });
    strict.deepStrictEqual(calls, ["execute", "execute", "signal", "deadline"]);
    strict.deepStrictEqual(database.executionCapabilities, { cancellation: true, deadlines: true });

    const unsupported = createDatabase(
      {
        async execute() {
          return [];
        },
      },
      renderer,
    );
    await strict.rejects(
      unsupported.all(query, { signal: new AbortController().signal }),
      (error: unknown) => error instanceof UnsupportedExecutionCapabilityError && error.capability === "cancellation",
    );
    await strict.rejects(
      unsupported.all(query, { deadline: Date.now() + 1_000 }),
      (error: unknown) => error instanceof UnsupportedExecutionCapabilityError && error.capability === "deadlines",
    );
    await strict.rejects(unsupported.all(query, { deadline: Number.NaN }), RangeError);
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
    const executor = {
      async execute(): Promise<readonly unknown[]> {
        return [{ value: 2 }];
      },
    };
    const db = createDatabase(executor, renderer, async (run) => run(executor));
    const value = await db.transaction(
      async (transaction) => (await transaction.execute(sql<{ value: number }>`SELECT 2 AS value`))[0]?.value,
    );
    strict.strictEqual(value, 2);
    await strict.rejects(
      () => createDatabase(executor, renderer).transaction(async () => undefined),
      /does not support transactions/,
    );
  });
});

await describe("core contracts", async () => {
  const schema = { formatVersion: 1, dialect: "test", tables: {} } satisfies SchemaSnapshot;
  const dialect: DialectPlugin<SchemaSnapshot, Record<string, never>> = {
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "test",
    grammarVersion: "1.0.0",
    sqlModule: "@example/typed-sql-test",
    capabilities: {},
    defaultTypePolicy: {},
    placeholder: (index) => `?${index}`,
    quoteIdentifier: (identifier) => `"${identifier}"`,
    analyze: (sql) => ({
      columns: [],
      parameters: [],
      diagnostics: [],
      semantics: unknownQuerySemantics({ start: 0, end: sql.length, line: 1, column: 1 }, "Test grammar"),
    }),
    validateSnapshot: () => schema,
  };

  await it("defines immutable typed configuration", () => {
    const config = defineConfig({
      dialect,
      schema: { file: "schema.json" },
      outDir: "generated",
      compiler: { maxStructuralVariants: 32 },
      manifest: { outFile: ".typed-sql/queries.json" },
    });
    strict.strictEqual(config.dialect, dialect);
    strict.strictEqual(config.compiler?.maxStructuralVariants, 32);
    strict.strictEqual(config.manifest?.outFile, ".typed-sql/queries.json");
    strict.ok(Object.isFrozen(config));
    strict.throws(
      () =>
        defineConfig({
          dialect: { ...dialect, contractVersion: 5 as never },
          schema: { file: "schema.json" },
          outDir: "generated",
        }),
      /Unsupported typed-sql dialect contract/,
    );
    for (const maximum of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      strict.throws(
        () =>
          defineConfig({
            dialect,
            schema: { file: "schema.json" },
            outDir: "generated",
            compiler: { maxStructuralVariants: maximum },
          }),
        /positive safe integer/,
      );
    }
    strict.throws(
      () =>
        defineConfig({
          dialect,
          schema: { file: "schema.json" },
          outDir: "generated",
          manifest: { outFile: "" },
        }),
      /manifest\.outFile must be a non-empty string/u,
    );
    const live = {
      dialect: dialect.id,
      adapterVersion: "test-v1",
      async server() {
        return { version: "test" };
      },
      async verify() {
        return { columns: [], parameters: [] };
      },
      async close() {},
    };
    strict.doesNotThrow(() =>
      defineConfig({
        dialect,
        schema: { file: "schema.json" },
        outDir: "generated",
        verification: { live, proofFile: ".typed-sql/proof.json", concurrency: 2 },
      }),
    );
    strict.throws(
      () =>
        defineConfig({
          dialect,
          schema: { file: "schema.json" },
          outDir: "generated",
          verification: { proofFile: "" },
        }),
      /verification\.proofFile/u,
    );
    strict.throws(
      () =>
        defineConfig({
          dialect,
          schema: { file: "schema.json" },
          outDir: "generated",
          verification: { concurrency: 0 },
        }),
      /verification\.concurrency/u,
    );
    strict.throws(
      () =>
        defineConfig({
          dialect,
          schema: { file: "schema.json" },
          outDir: "generated",
          verification: { live: { ...live, dialect: "other" } },
        }),
      /does not match/u,
    );
    strict.doesNotThrow(() =>
      defineConfig({
        dialect,
        schema: { file: "schema.json" },
        outDir: "generated",
        compatibility: { reportFile: ".typed-sql/compatibility.json", failOn: "warning" },
      }),
    );
    strict.throws(
      () =>
        defineConfig({
          dialect,
          schema: { file: "schema.json" },
          outDir: "generated",
          compatibility: { reportFile: "" },
        }),
      /compatibility\.reportFile/u,
    );
    strict.throws(
      () =>
        defineConfig({
          dialect,
          schema: { file: "schema.json" },
          outDir: "generated",
          compatibility: { failOn: "all" as never },
        }),
      /compatibility\.failOn/u,
    );
    const planInspector = {
      dialect: dialect.id,
      adapterVersion: "test-plan-v1",
      parameterMode: "value-free" as const,
      async environment() {
        return { version: "test", settings: {}, statisticsFingerprint: `sha256:${"a".repeat(64)}` };
      },
      async capture() {
        return { nodes: [] };
      },
      async close() {},
    };
    strict.doesNotThrow(() =>
      defineConfig({
        dialect,
        schema: { file: "schema.json" },
        outDir: "generated",
        plans: {
          live: planInspector,
          artifactFile: ".typed-sql/plans.json",
          reportFile: ".typed-sql/plan-review.json",
          baselineFile: "artifacts/plans.json",
          concurrency: 2,
          failOn: "uncertainty",
          budgets: {
            defaults: { maximumTotalCost: 10, maximumTotalCostIncreaseRatio: 1.5 },
            queries: { [`sha256:${"b".repeat(64)}`]: { forbiddenNodeKinds: ["Seq Scan"] } },
          },
        },
      }),
    );
    for (const plans of [
      { artifactFile: "" },
      { concurrency: 0 },
      { failOn: "all" },
      { live: { ...planInspector, dialect: "other" } },
      { budgets: { defaults: { maximumTotalCost: -1 } } },
      { budgets: { defaults: { maximumTotalCostIncreaseRatio: 0.5 } } },
      { budgets: { queries: { invalid: {} } } },
    ]) {
      strict.throws(
        () =>
          defineConfig({
            dialect,
            schema: { file: "schema.json" },
            outDir: "generated",
            plans: plans as never,
          }),
        /plans/u,
      );
    }
  });

  await it("validates every public dialect contract boundary", () => {
    strict.doesNotThrow(() => assertDialectPlugin(dialect));
    const withoutPolicy = Object.fromEntries(Object.entries(dialect).filter(([key]) => key !== "defaultTypePolicy"));
    for (const invalid of [
      null,
      { ...dialect, contractVersion: 2 },
      { ...dialect, id: "" },
      { ...dialect, grammarVersion: "" },
      { ...dialect, sqlModule: "" },
      withoutPolicy,
      { ...dialect, capabilities: [] },
      { ...dialect, capabilities: { returning: "yes" } },
      { ...dialect, placeholder: undefined },
      { ...dialect, quoteIdentifier: undefined },
      { ...dialect, analyze: undefined },
      { ...dialect, validateSnapshot: undefined },
    ]) {
      strict.throws(() => assertDialectPlugin(invalid));
    }
  });

  await it("publishes the stable diagnostic registry", () => {
    strict.strictEqual(diagnosticRegistry.TSQ301.category, "drift");
    strict.strictEqual(isTypedSqlDiagnosticCode("TSQ401"), true);
    strict.strictEqual(isTypedSqlDiagnosticCode("TSQ500"), true);
    strict.strictEqual(isTypedSqlDiagnosticCode("TSQ999"), false);
    strict.ok(Object.isFrozen(diagnosticRegistry));
  });

  await it("renders deterministic TypeScript row literals", () => {
    strict.strictEqual(
      rowTypeLiteral([
        { name: "id", tsType: "bigint", nullable: false, range: { start: 0, end: 1, line: 1, column: 1 } },
        { name: "display name", tsType: "string", nullable: true, range: { start: 2, end: 3, line: 1, column: 3 } },
      ]),
      '{ "id": bigint; "display name": string | null; }',
    );
  });

  await it("renders ordered parameter tuples with unresolved positions", () => {
    strict.strictEqual(
      parameterTypeLiteral(4, [
        { index: 1, tsType: "bigint", nullable: false, databaseType: "int8" },
        { index: 3, tsType: '"active" | "suspended"', nullable: false },
        { index: 4, tsType: "string", nullable: true },
      ]),
      'readonly [bigint, unknown, "active" | "suspended", string | null]',
    );
  });

  await it("shares indexed schema and parameter primitives with future grammars", () => {
    const indexedSchema: SchemaSnapshot = {
      formatVersion: 1,
      dialect: "test",
      tables: {
        "public.Users": {
          schema: "public",
          name: "Users",
          columns: {
            UserId: { name: "UserId", databaseType: "integer", tsType: "number", nullable: false },
          },
        },
      },
      functions: {
        "public.lookup": {
          schema: "public",
          name: "lookup",
          argumentTypes: ["integer"],
          returnType: "string",
          nullable: false,
        },
      },
    };
    const index = new ResolverSchemaIndex(indexedSchema);
    strict.strictEqual(ResolverSchemaIndex.for(indexedSchema), ResolverSchemaIndex.for(indexedSchema));
    const table = index.tables("users", "PUBLIC")[0]?.table;
    strict.ok(table !== undefined);
    strict.strictEqual(index.tables("users").length, 1);
    strict.strictEqual(index.tables("Users", "public", true).length, 1);
    strict.strictEqual(index.tables("missing").length, 0);
    strict.strictEqual(index.column(table!, "userid")?.name, "UserId");
    strict.strictEqual(index.column(table!, "UserId", true)?.name, "UserId");
    strict.strictEqual(index.column(table!, "userid", true), undefined);
    const synthetic = {
      name: "recent_users",
      columns: {
        total: { name: "total", databaseType: "integer", tsType: "number", nullable: false },
      },
    } as const;
    strict.strictEqual(index.column(synthetic, "TOTAL")?.tsType, "number");
    strict.strictEqual(index.functions("lookup", 1).length, 1);
    strict.strictEqual(index.functions("LOOKUP", 1, "PUBLIC").length, 1);
    strict.strictEqual(index.functions("lookup", 2).length, 0);

    const parameters = new ParameterCollector();
    parameters.record(1);
    parameters.record(1, { tsType: "number", nullable: false, databaseType: "integer" });
    parameters.record(1, { tsType: "number", nullable: true, databaseType: "integer" });
    strict.deepStrictEqual(parameters.values(), [
      {
        index: 1,
        tsType: "number",
        nullable: true,
        databaseType: "integer",
      },
    ]);
    parameters.record(1, { tsType: "string", nullable: false, databaseType: "text" });
    strict.deepStrictEqual(parameters.values(), [{ index: 1, tsType: "unknown", nullable: true }]);
    strict.deepStrictEqual(parameters.record(1, { tsType: "number", nullable: false }), {
      index: 1,
      tsType: "unknown",
      nullable: true,
    });
    parameters.record(2, { tsType: "string", nullable: false, databaseType: "varchar" });
    parameters.record(2);
    parameters.record(2, { tsType: "string", nullable: false, databaseType: "text" });
    strict.deepStrictEqual(parameters.values()[1], { index: 2, tsType: "string", nullable: false });
    strict.strictEqual(unionTypeLiterals(["string", "number", "string"]), "string | number");
    strict.strictEqual(unionTypeLiterals(["string", "unknown"]), "unknown");
    strict.strictEqual(unionTypeLiterals([]), "unknown");
    strict.strictEqual(closestName("uesrs", ["accounts", "users"]), "users");
    strict.strictEqual(closestName("x", ["accounts"]), undefined);
    strict.strictEqual(closestName("users", []), undefined);
  });

  await it("indexes v2 relation, uniqueness, DML, and routine evidence without dialect semantics", () => {
    const table = {
      schema: "app",
      name: "users",
      columns: {
        id: { name: "id", databaseType: "int", tsType: "number", nullable: false },
        email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
      },
    } as const;
    const snapshot: SchemaSnapshot = {
      formatVersion: 2,
      dialect: "test",
      tables: { users: table },
      relations: {
        users: {
          schema: "app",
          name: "users",
          kind: "table",
          columns: {
            id: {
              name: "id",
              position: 0,
              databaseType: "int",
              typeIdentity: "test:int",
              tsType: "number",
              nullable: false,
              default: "present",
              generated: "none",
              identity: "by-default",
              insertable: true,
              updatable: true,
            },
            email: {
              name: "email",
              position: 1,
              databaseType: "text",
              typeIdentity: "test:text",
              tsType: "string",
              nullable: false,
              default: "none",
              generated: "none",
              identity: "none",
              insertable: true,
              updatable: false,
            },
          },
          constraints: [
            {
              kind: "primary-key",
              identity: "users-pkey",
              columns: ["id"],
              partial: false,
              expressionBased: false,
              nullsDistinct: false,
            },
            {
              kind: "unique",
              identity: "users-email-partial",
              columns: ["email"],
              partial: true,
              expressionBased: false,
              nullsDistinct: true,
            },
          ],
        },
      },
      routines: {
        "app.lookup": [
          {
            name: "lookup",
            schema: "app",
            identity: "lookup-int",
            kind: "function",
            arguments: [{ mode: "in", databaseType: "int", tsType: "number" }],
            result: { kind: "scalar", databaseType: "text", tsType: "string", nullable: false },
            volatility: "stable",
          },
        ],
        "app.format": [
          {
            name: "format",
            schema: "app",
            identity: "format-default",
            kind: "function",
            arguments: [
              { name: "value", mode: "in", databaseType: "text", tsType: "string", default: "none" },
              { name: "style", mode: "in", databaseType: "text", tsType: "string", default: "present" },
            ],
            result: { kind: "scalar", databaseType: "text", tsType: "string", nullable: false },
            volatility: "immutable",
          },
        ],
        "app.collect": [
          {
            name: "collect",
            schema: "app",
            identity: "collect-variadic",
            kind: "function",
            arguments: [{ name: "values", mode: "variadic", databaseType: "text[]", tsType: "readonly string[]" }],
            result: { kind: "scalar", databaseType: "text", tsType: "string", nullable: false },
            volatility: "immutable",
          },
        ],
      },
    };
    const index = new ResolverSchemaIndex(snapshot);
    strict.deepStrictEqual(index.uniqueColumnSets(table), [["id"]]);
    strict.strictEqual(index.isUnique(table, ["ID"]), true);
    strict.strictEqual(index.isUnique(table, ["email"]), false);
    strict.strictEqual(index.columnEligibility(table, table.columns.email, "update"), false);
    const required = index.requiredInsertColumns(table);
    if (required === "unknown") throw new Error("expected v2 insert evidence");
    strict.deepStrictEqual(
      required.map(({ name }) => name),
      ["email"],
    );
    strict.strictEqual(index.functions("lookup", 1, "app")[0]?.returnType, "string");
    strict.strictEqual(index.routineOverloads("lookup", 1, "APP")[0]?.identity, "lookup-int");
    strict.strictEqual(index.routineOverloads("format", 1, "app")[0]?.identity, "format-default");
    strict.strictEqual(index.routineOverloads("collect", 0, "app")[0]?.identity, "collect-variadic");
    strict.strictEqual(index.routineOverloads("collect", 3, "app")[0]?.identity, "collect-variadic");

    const legacy = new ResolverSchemaIndex({ formatVersion: 1, dialect: "test", tables: { users: table } });
    strict.strictEqual(legacy.isUnique(table, ["id"]), "unknown");
    strict.strictEqual(legacy.requiredInsertColumns(table), "unknown");
  });
});
