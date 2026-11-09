import {
  acquireNativeQueryContract,
  type ContractReconciliationContribution,
  createStaticQueryClaim,
  queryContractDigest,
  reconcileQueryContract,
} from "@typed-sql/analysis";
import { describe, it, strict } from "poku";
import { sqlserver } from "../src/browser.js";
import { sqlServerContractDescriptionQueries } from "../src/contract-descriptors.js";
import {
  sqlServerContractIdentity,
  sqlServerContractPolicy,
  sqlServerContractReconciliationOwner,
} from "../src/contract-profile.js";
import type { SqlServerServicePool, SqlServerServiceSession } from "../src/live-verifier.js";
import { createSqlServerLiveVerifier } from "../src/live-verifier.js";
import {
  createSqlServerNativeContractAdapter,
  SqlServerContractAcquisitionError,
  sqlServerContractContextQueries,
  sqlServerContractRelationQuery,
} from "../src/native-contracts.js";
import { createSqlServerOdbcNativeContractAdapter } from "../src/odbc-contracts.js";
import { sqlserverProfile } from "../src/profile.js";
import { createSqlServerContractReconciler } from "../src/reconciliation.js";
import { readSqlServerServerEvidence, sqlServerServerQueries } from "../src/server-evidence.js";
import { ServiceHarness } from "./helpers/verification-services.js";

const schemaSession = await new ServiceHarness().acquire();
const schema = {
  formatVersion: 1 as const,
  dialect: "sqlserver" as const,
  tables: {},
  server: (await readSqlServerServerEvidence(schemaSession)).server,
};
await schemaSession.release();
const candidate = (sql = "SELECT CAST(@__typed_sql_1 AS bigint) AS value") => ({
  sql,
  parameterOccurrences: sqlserverProfile().parameterOccurrences!(sql, schema).map(({ index, range }) => ({
    index,
    start: range.start,
    end: range.end,
  })),
});
const column = {
  is_hidden: 0,
  column_ordinal: 1,
  name: "value",
  system_type_name: "bigint",
  system_type_id: 127,
  user_type_id: null,
  user_type_name: null,
  assembly_qualified_type_name: null,
  collation_name: null,
  is_nullable: 1,
  error_number: null,
  error_type: null,
};
const parameter = {
  parameter_ordinal: 1,
  name: "@__typed_sql_1",
  suggested_system_type_name: "bigint",
  suggested_system_type_id: 127,
  suggested_user_type_id: null,
  suggested_user_type_name: null,
  suggested_assembly_qualified_type_name: null,
  suggested_is_input: 1,
  suggested_is_output: 0,
};
function fixture() {
  const base = new ServiceHarness();
  let lsn = "00000001:00000001:0001",
    version = "17.0.5035.5",
    dateFirst = 7,
    visible = 1;
  let hook = async (_sql: string, _values: readonly unknown[]) => {};
  let columns: readonly Record<string, unknown>[] = [column],
    parameters: readonly Record<string, unknown>[] = [parameter];
  const sessions: SqlServerServiceSession[] = [];
  const catalog: Record<string, readonly Record<string, unknown>[]> = {};
  const pool: SqlServerServicePool = {
    async acquire() {
      const ordinal = sessions.length + 1;
      const session: SqlServerServiceSession = {
        async all<Row extends Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = [],
        ): Promise<readonly Row[]> {
          await hook(sql, values);
          let result: readonly Record<string, unknown>[];
          if (sql === sqlServerContractContextQueries.guard)
            result = [
              {
                database_guid: "11111111-1111-1111-1111-111111111111",
                recovery_fork_guid: "22222222-2222-2222-2222-222222222222",
                connection_id: `33333333-3333-3333-3333-${String(ordinal).padStart(12, "0")}`,
                session_id: ordinal,
                transaction_count: 0,
                session_options: 5496,
                log_end_lsn: lsn,
              },
            ];
          else if (sql === sqlServerContractDescriptionQueries.parameters) result = parameters;
          else if (sql === sqlServerContractDescriptionQueries.columns) result = columns;
          else if (sql === sqlServerContractRelationQuery) result = catalog.resolved ?? [{ object_id: 42 }];
          else if (sql in catalog) result = catalog[sql]!;
          else if (Object.values(sqlServerContractContextQueries).some((query) => query === sql)) result = [];
          else {
            result = await base.query(sql, values);
            if (sql === sqlServerServerQueries.server)
              result = result.map((row) => ({ ...row, version, date_first: dateFirst, can_view_definition: visible }));
          }
          return result as readonly Row[];
        },
        release() {
          base.released++;
        },
        discard() {
          base.discarded++;
        },
      };
      sessions.push(session);
      return session;
    },
  };
  return {
    base,
    pool,
    sessions,
    catalog,
    get lsn() {
      return lsn;
    },
    set lsn(value) {
      lsn = value;
    },
    set dateFirst(value: number) {
      dateFirst = value;
    },
    set visible(value: number) {
      visible = value;
    },
    set version(value: string) {
      version = value;
    },
    set hook(value: typeof hook) {
      hook = value;
    },
    set columns(value: typeof columns) {
      columns = value;
    },
    set parameters(value: typeof parameters) {
      parameters = value;
    },
  };
}

const ordinary = {
  object_id: 42,
  is_memory_optimized: 0,
  is_filetable: 0,
  is_remote_data_archive_enabled: 0,
  temporal_type: 0,
  is_external: 0,
  is_node: 0,
  is_edge: 0,
};
const storedColumn = {
  object_id: 42,
  system_type_id: 127,
  user_type_id: 127,
  is_computed: 0,
  is_hidden: 0,
  encryption_type: null,
  generated_always_type: 0,
  xml_collection_id: 0,
};
const systemType = { user_type_id: 127, name: "bigint", is_user_defined: 0, is_assembly_type: 0 };
function tableFixture() {
  const f = fixture();
  f.catalog[sqlServerContractContextQueries.tables] = [ordinary];
  f.catalog[sqlServerContractContextQueries.columns] = [storedColumn];
  f.catalog[sqlServerContractContextQueries.types] = [systemType];
  return f;
}

await describe("guarded SQL Server contract acquisition", async () => {
  await it("keeps the owned ODBC adapter lazy and sanitizes a failed native connection", async () => {
    let imports = 0;
    const adapter = createSqlServerOdbcNativeContractAdapter({
      schema,
      connectionString: "private-connection-string",
      driverImporter: async () => {
        imports++;
        throw Error("private-driver-message");
      },
    });
    strict.equal(imports, 0);
    strict.equal(adapter.accept?.(candidate("DELETE FROM private_table")).accepted, false);
    strict.equal(imports, 0);
    await strict.rejects(
      adapter.open(),
      (error: unknown) => error instanceof SqlServerContractAcquisitionError && !error.message.includes("private"),
    );
    strict.equal(imports, 1);
  });
  await it("binds descriptions as data, uses independent native facets and releases clean leases", async () => {
    const f = fixture(),
      adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema });
    const context = await adapter.inspectContext();
    strict.equal(f.base.released, 1);
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    f.hook = async (sql, values) => {
      calls.push({ sql, values });
    };
    const result = await acquireNativeQueryContract({ adapter, context, candidate: candidate() });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw Error("Expected native acquisition");
    strict.deepEqual(result.contract.valuePlan.columns, [
      { name: "value", type: "bigint", databaseType: "bigint", nullable: true },
    ]);
    strict.deepEqual(calls.find(({ sql }) => sql === sqlServerContractDescriptionQueries.parameters)?.values, [
      candidate().sql,
    ]);
    strict.deepEqual(calls.find(({ sql }) => sql === sqlServerContractDescriptionQueries.columns)?.values, [
      candidate().sql,
      "@__typed_sql_1 bigint",
    ]);
    strict.ok(!calls.some(({ sql }) => sql === candidate().sql));
    strict.equal(f.base.released, 2);
    strict.equal(f.base.discarded, 0);
  });
  await it("declines unqualified or remote objects, procedural SQL, qualified functions and noncanonical binds", () => {
    const f = fixture(),
      adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema });
    for (const sql of [
      "SELECT value FROM widgets",
      "SELECT value FROM remote.dbo.widgets",
      "SELECT value FROM dbo.widgets WITH (NOLOCK)",
      "SELECT value FROM dbo.widgets FOR SYSTEM_TIME ALL",
      "SELECT value FROM dbo.widgets CROSS APPLY dbo.other(1) AS b",
      "SELECT dbo.user_function(1) AS value",
      "SELECT CAST(1 AS dbo.custom) AS value",
      "EXEC dbo.proc",
      "SELECT 1; SELECT 2",
      "WITH c AS (SELECT 1 AS value) SELECT value FROM c",
      "SELECT @other AS value",
      "SELECT 1 INTO dbo.created",
      "SELECT (SELECT 1) AS value",
    ]) {
      strict.equal(adapter.accept({ sql, parameterOccurrences: [] }).accepted, false, sql);
    }
    strict.equal(
      adapter.accept({ sql: "SELECT @__typed_sql_2 AS value", parameterOccurrences: [{ index: 2, start: 7, end: 20 }] })
        .accepted,
      false,
    );
    strict.equal(adapter.accept(candidate()).accepted, true);
    strict.equal(adapter.accept(candidate("SELECT IIF(1=1, 1, 2) AS value")).accepted, true);
    strict.equal(
      adapter.accept(
        candidate("SELECT a.* FROM dbo.widgets a LEFT JOIN dbo.other b ON a.id=b.id WHERE a.id=@__typed_sql_1"),
      ).accepted,
      true,
    );
    strict.equal(f.sessions.length, 0);
  });
  await it("qualifies local table catalogs and resolves quoted names as bound metadata", async () => {
    const f = tableFixture(),
      calls: { sql: string; values: readonly unknown[] }[] = [];
    f.hook = async (sql, values) => {
      calls.push({ sql, values });
    };
    const adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema }),
      session = await adapter.open(),
      query = candidate("SELECT a.value FROM [odd.schema].[odd'table] a WHERE a.value=@__typed_sql_1");
    const result = await session.describe(query);
    strict.deepEqual(result.columns[0]?.runtimeType, { status: "known", value: "bigint" });
    strict.deepEqual(calls.find(({ sql }) => sql === sqlServerContractRelationQuery)?.values, [
      "odd.schema",
      "odd'table",
    ]);
    strict.ok(!calls.some(({ sql }) => sql === query.sql));
    await session.close();
    const before = await adapter.inspectContext();
    f.catalog[sqlServerContractContextQueries.tables] = [{ ...ordinary, is_external: 1 }];
    strict.notEqual((await adapter.inspectContext()).databaseContextHash, before.databaseContextHash);
  });
  await it("rejects unsafe or incomplete table evidence before native candidate description", async () => {
    const mutations: ((f: ReturnType<typeof tableFixture>) => void)[] = [
      (f) => {
        f.catalog.resolved = [{ object_id: null }];
      },
      (f) => {
        f.catalog.resolved = [];
      },
      (f) => {
        f.catalog[sqlServerContractContextQueries.tables] = [];
      },
      (f) => {
        f.catalog[sqlServerContractContextQueries.columns] = [];
      },
      (f) => {
        f.catalog[sqlServerContractContextQueries.types] = [];
      },
      (f) => {
        f.catalog[sqlServerContractContextQueries.predicates] = [{ target_object_id: 42 }];
      },
      ...[
        "is_memory_optimized",
        "is_filetable",
        "is_remote_data_archive_enabled",
        "is_external",
        "is_node",
        "is_edge",
        "temporal_type",
      ].map((key) => (f: ReturnType<typeof tableFixture>) => {
        f.catalog[sqlServerContractContextQueries.tables] = [{ ...ordinary, [key]: 1 }];
      }),
      ...[
        "is_computed",
        "is_hidden",
        "encryption_type",
        "generated_always_type",
        "xml_collection_id",
        "user_type_id",
      ].map((key) => (f: ReturnType<typeof tableFixture>) => {
        f.catalog[sqlServerContractContextQueries.columns] = [{ ...storedColumn, [key]: 1 }];
      }),
      ...[{ is_user_defined: 1 }, { is_assembly_type: 1 }, { name: "opaque" }].map(
        (patch) => (f: ReturnType<typeof tableFixture>) => {
          f.catalog[sqlServerContractContextQueries.types] = [{ ...systemType, ...patch }];
        },
      ),
    ];
    for (const mutate of mutations) {
      const f = tableFixture();
      mutate(f);
      let descriptions = 0;
      f.hook = async (sql) => {
        if (sql === sqlServerContractDescriptionQueries.columns) descriptions++;
      };
      const session = await createSqlServerNativeContractAdapter({ pool: f.pool, schema }).open();
      await strict.rejects(session.describe(candidate("SELECT value FROM dbo.widgets")), /unsupported-statement/u);
      strict.equal(descriptions, 0);
      strict.equal(f.base.discarded, 1);
    }
  });
  await it("rejects DDL racing with name resolution before describing the candidate", async () => {
    const f = tableFixture();
    let descriptions = 0;
    f.hook = async (sql) => {
      if (sql === sqlServerContractRelationQuery) f.lsn = "00000001:00000002:0001";
      if (sql === sqlServerContractDescriptionQueries.columns) descriptions++;
    };
    const session = await createSqlServerNativeContractAdapter({ pool: f.pool, schema }).open();
    await strict.rejects(session.describe(candidate("SELECT value FROM dbo.widgets")), /context-changed/u);
    strict.equal(descriptions, 0);
  });
  await it("fences log drift and settings changes instead of publishing mixed observations", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.lsn = "00000001:00000002:0001";
      },
      (f: ReturnType<typeof fixture>) => {
        f.dateFirst = 1;
      },
    ]) {
      const f = fixture(),
        adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema });
      const session = await adapter.open();
      f.hook = async (sql) => {
        if (sql === sqlServerContractDescriptionQueries.columns) mutate(f);
      };
      await strict.rejects(session.describe(candidate()), /context-changed/u);
      await session.close();
      strict.equal(f.base.discarded, 1);
      strict.equal(f.base.released, 0);
      await strict.rejects(session.context(), /closed-session/u);
    }
  });
  await it("requires a qualified server and visible definitions and redacts native diagnostics", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.visible = 0;
      },
      (f: ReturnType<typeof fixture>) => {
        f.version = "18.0.1.1";
      },
    ]) {
      const f = fixture();
      change(f);
      await strict.rejects(createSqlServerNativeContractAdapter({ pool: f.pool, schema }).open());
      strict.equal(f.base.discarded, 1);
    }
    const f = fixture(),
      adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema });
    const session = await adapter.open();
    f.hook = async (sql) => {
      if (sql === sqlServerContractDescriptionQueries.columns)
        throw Object.assign(Error("private SQL or credentials"), { diagnostics: [{ native: 195, state: "42000" }] });
    };
    await strict.rejects(
      session.describe(candidate()),
      (error) =>
        error instanceof SqlServerContractAcquisitionError &&
        error.reason === "native-rejected" &&
        !error.message.includes("private"),
    );
    strict.equal(f.base.discarded, 1);
    strict.deepEqual(adapter.classifyError!(new SqlServerContractAcquisitionError("context-changed")), {
      kind: "stale-context",
      code: "sqlserver-context-changed",
    });
    strict.equal(adapter.classifyError!(new SqlServerContractAcquisitionError("metadata-unavailable")).kind, "partial");
  });
  await it("does not promote missing parameter metadata or native metadata error rows", async () => {
    for (const result of [
      [{ ...column, error_number: 195 }],
      [{ ...column, error_number: 11509 }],
      [{ ...column, name: null }],
    ]) {
      const f = fixture();
      f.columns = result;
      const session = await createSqlServerNativeContractAdapter({ pool: f.pool, schema }).open();
      await strict.rejects(session.describe(candidate()));
      strict.equal(f.base.discarded, 1);
    }
    const f = fixture();
    f.parameters = [];
    const session = await createSqlServerNativeContractAdapter({ pool: f.pool, schema }).open();
    await strict.rejects(session.describe(candidate()), /metadata-unavailable/u);
    strict.equal(f.base.discarded, 1);
  });
  await it("bounds stalled operations, disposes late acquisitions and quarantines cancellation", async () => {
    let resolve!: (session: SqlServerServiceSession) => void;
    const f = fixture();
    const adapter = createSqlServerNativeContractAdapter({
      pool: {
        acquire: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      schema,
      statementTimeoutMs: 20,
    });
    await strict.rejects(adapter.open(), /deadline/u);
    const late = await f.pool.acquire();
    resolve(late);
    for (let i = 0; f.base.discarded === 0 && i < 100; i++) await new Promise((done) => setTimeout(done, 1));
    strict.equal(f.base.discarded, 1);
    const g = fixture(),
      active = createSqlServerNativeContractAdapter({ pool: g.pool, schema, statementTimeoutMs: 100 });
    const session = await active.open();
    let started!: () => void;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    g.hook = async (sql) => {
      if (sql === sqlServerContractDescriptionQueries.columns) {
        started();
        await new Promise(() => {});
      }
    };
    const controller = new AbortController();
    const work = session.describe(candidate(), controller.signal);
    const rejected = strict.rejects(work);
    await ready;
    controller.abort();
    await rejected;
    strict.equal(g.base.discarded, 1);
    await session.close();
  });
  await it("discards an active close and shares exclusivity with verification services", async () => {
    const f = fixture(),
      adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema });
    const session = await adapter.open();
    const native = f.sessions[0]!;
    const verifier = createSqlServerLiveVerifier({ pool: { acquire: async () => native } });
    await strict.rejects(verifier.server());
    strict.equal(f.base.discarded, 0);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((done) => {
      started = done;
    });
    f.hook = async (sql) => {
      if (sql === sqlServerContractDescriptionQueries.columns) {
        started();
        await new Promise<void>((done) => {
          release = done;
        });
      }
    };
    const operation = session.describe(candidate());
    const rejected = strict.rejects(operation);
    await waiting;
    await session.close();
    release();
    await rejected;
    strict.equal(f.base.discarded, 1);
    strict.equal(f.base.released, 0);
    await strict.rejects(
      createSqlServerNativeContractAdapter({ pool: { acquire: async () => native }, schema }).open(),
      /unsupported-context/u,
    );
  });
  await it("makes failed cleanup blocking, including a rejection without an Error object", async () => {
    const f = fixture(),
      native = await f.pool.acquire();
    native.release = () => Promise.reject(undefined);
    const adapter = createSqlServerNativeContractAdapter({
      pool: { acquire: async () => native },
      schema,
      statementTimeoutMs: 50,
    });
    const session = await adapter.open();
    await strict.rejects(session.close(), /cleanup-failed/u);
    strict.equal(f.base.discarded, 1);
    await strict.rejects(adapter.open(), /cleanup-failed/u);
  });
  await it("reconciles independently and rejects successful but contradictory static claims", async () => {
    const f = fixture(),
      adapter = createSqlServerNativeContractAdapter({ pool: f.pool, schema }),
      query = candidate();
    const captured = await acquireNativeQueryContract({
      adapter,
      candidate: query,
      context: await adapter.inspectContext(),
    });
    if (captured.status !== "acquired") throw Error("Expected acquired contract");
    const claim = createStaticQueryClaim({
      sql: query.sql,
      context: captured.contract.context,
      analysis: sqlserver().analyze(query.sql, schema),
    });
    const policy = {
      mode: "native-required" as const,
      owner: sqlServerContractReconciliationOwner,
      requiredNativeFacets: ["runtime-type" as const],
    };
    const contribution = createSqlServerContractReconciler();
    for (const [code, severity, status] of [
      ["TSQ105", "error", "unsupported"],
      ["TSQ408", "error", "unsupported"],
      ["TSQ202", "error", "invalid"],
      ["TSQ202", "warning", "resolved"],
    ] as const)
      strict.equal(contribution.classify({ ...claim, diagnostics: [{ code, severity }] }).status, status);
    const reconciled = reconcileQueryContract({
      nativeContract: captured.contract,
      staticClaim: claim,
      policy,
      contribution,
    });
    strict.equal(reconciled.status, "qualified", JSON.stringify(reconciled));
    const { digest: _, ...body } = claim;
    const changed = {
      ...body,
      columns: body.columns.map((column) => ({
        ...column,
        tsType: "string",
        databaseType: "varchar(12)",
        runtimeType: "string" as const,
      })),
    };
    strict.equal(
      reconcileQueryContract({
        nativeContract: captured.contract,
        staticClaim: { ...changed, digest: queryContractDigest(changed) },
        policy,
        contribution,
      }).status,
      "conflict",
    );
    const unknown = {
      ...body,
      columns: body.columns.map((column) => ({
        ...column,
        tsType: "unknown",
        databaseType: undefined,
        runtimeType: undefined,
      })),
    };
    // Omitted fields remain data-only rather than serializing undefined properties.
    const normalized = JSON.parse(JSON.stringify(unknown));
    strict.equal(
      reconcileQueryContract({
        nativeContract: captured.contract,
        staticClaim: { ...normalized, digest: queryContractDigest(normalized) },
        policy,
        contribution,
      }).status,
      "qualified",
    );
    strict.throws(
      () =>
        sqlServerContractPolicy({ ...sqlServerContractPolicy(), extra: true } as ReturnType<
          typeof sqlServerContractPolicy
        >),
      /policy/u,
    );
    strict.notDeepEqual(
      sqlServerContractIdentity(),
      sqlServerContractIdentity({ ...sqlServerContractPolicy(), bigint: "string" }),
    );
  });
  await it("preserves partial identities, codec policies and conservative native bounds", async () => {
    type Comparison = Parameters<ContractReconciliationContribution["compare"]>[0];
    const contribution = createSqlServerContractReconciler();
    const base: Comparison = {
      target: "column",
      index: 1,
      facet: "native-type",
      expected: { tsType: "string", databaseType: "varchar(12)", nullable: true },
      native: {
        nativeType: { status: "known", value: { name: "varchar(12)", complete: true } },
        runtimeType: { status: "known", value: "string" },
        nullable: { status: "known", value: true, precision: "exact" },
        descriptor: {},
      },
    };
    const compare = (change: Partial<Comparison>) => contribution.compare({ ...base, ...change });
    strict.equal(compare({}).status, "compatible");
    for (const [name, complete, status] of [
      ["varchar(13)", true, "conflict"],
      ["varchar(12)", false, "widened"],
      ["opaque", false, "unavailable"],
    ] as const) {
      strict.equal(
        compare({ native: { ...base.native, nativeType: { status: "known", value: { name, complete } } } }).status,
        status,
      );
    }
    strict.equal(compare({ expected: { tsType: "string", nullable: true } }).staticStatus, "unknown");
    strict.equal(
      compare({ native: { ...base.native, nativeType: { status: "unknown", reason: "missing" } } }).status,
      "widened",
    );
    for (const name of ["varchar(1)", "nvarchar(12)"]) {
      strict.equal(
        compare({
          expected: { ...base.expected, databaseTypeIsPartial: true },
          native: { ...base.native, nativeType: { status: "known", value: { name, complete: true } } },
        }).status,
        name.startsWith("varchar") ? "widened" : "conflict",
      );
    }
    strict.equal(
      compare({
        expected: { ...base.expected, databaseType: "varchar(12) COLLATE Latin1_General_100_CI_AS" },
        native: {
          ...base.native,
          nativeType: {
            status: "known",
            value: { name: "varchar(12) COLLATE Latin1_General_100_CS_AS", complete: true },
          },
        },
      }).status,
      "conflict",
    );
    strict.equal(compare({ facet: "nullability", expected: { ...base.expected, nullable: false } }).status, "conflict");
    strict.equal(compare({ facet: "nullability" }).status, "compatible");
    strict.equal(
      compare({ facet: "nullability", native: { ...base.native, nullable: { status: "unknown", reason: "missing" } } })
        .status,
      "widened",
    );
    strict.equal(
      compare({ facet: "runtime-type", expected: { ...base.expected, tsType: "bigint" } }).rule,
      "static-codec-policy-conflict",
    );
    strict.equal(
      compare({ facet: "runtime-type", expected: { ...base.expected, runtimeType: "bigint" } }).rule,
      "static-runtime-descriptor-conflict",
    );
    strict.equal(
      compare({
        facet: "runtime-type",
        native: { ...base.native, runtimeType: { status: "unknown", reason: "missing" } },
      }).status,
      "widened",
    );
    strict.equal(
      compare({ facet: "runtime-type", native: { ...base.native, runtimeType: { status: "known", value: "number" } } })
        .status,
      "conflict",
    );
    strict.equal(
      compare({ facet: "runtime-type", expected: { tsType: "Decimal", databaseType: "decimal(12,2)", nullable: true } })
        .staticStatus,
      "known",
    );
    const json = { json: { shape: { kind: "unknown" as const }, representation: "text" as const } };
    strict.equal(
      compare({
        facet: "runtime-type",
        expected: { tsType: "JsonValue", nullable: true },
        native: { ...base.native, runtimeType: { status: "known", value: json } },
      }).status,
      "widened",
    );
  });
});
