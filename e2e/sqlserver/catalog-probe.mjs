import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSqlFile } from "@typed-sql/compiler";
import { SqlServerSchemaProvider, sqlserver } from "@typed-sql/sqlserver";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";

// This probe never changes an application database. Every compatibility profile gets
// a unique disposable database; all grants/denials belong to its WITHOUT LOGIN user.
const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password), "Disposable password without DSN delimiters required");
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok([14, 15, 16, 17].includes(major));
assert.equal(process.arch, "x64", "Native catalog qualification requires the pinned Linux x86-64 runner");
const build = process.env.TYPED_SQL_SQLSERVER_BUILD;
assert.match(build ?? "", new RegExp(`^${major}\\.\\d+\\.\\d+\\.\\d+$`, "u"));
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const output = fileURLToPath(new URL(`../../artifacts/sqlserver/catalog-${major}.json`, import.meta.url));
const generated = await mkdtemp(new URL(".catalog-generated-", import.meta.url));
const grammar = sqlserver(),
  failures = [];
const evidence = {
  formatVersion: 1,
  major,
  expectedBuild: build,
  adapter: "public-default-odbc",
  profiles: [],
  limitations: [],
};
let queryId = 0;
const integer = (value) => {
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result));
  return result;
};
const flag = (value) => {
  assert.ok([0, 1, false, true, "0", "1"].includes(value), `Canonical native flag: ${String(value)}`);
  return value === 1 || value === true || value === "1";
};
const attributes = (value) => value.extension?.attributes ?? {};
const hash = (value) => assert.match(value ?? "", /^sha256:[a-f\d]{64}$/u);
const quote = (value) => `[${value.replaceAll("]", "]]")}]`;
const literal = (value) => `N'${value.replaceAll("'", "''")}'`;
const redact = (error) => String(error).replaceAll(password, "[redacted]");
async function compiled(snapshot, source) {
  const result = compileSqlFile({ dialect: grammar, schema: snapshot, source });
  assert.deepEqual(result.diagnostics, [], `Compiled SQL: ${source}`);
  const file = new URL(`${queryId++}.mjs`, pathToFileURL(`${generated}/`));
  await writeFile(file, result.runtime);
  const module = await import(file.href);
  return { factory: module.default, plan: module.valuePlan, query: result.query };
}
function rejectsAnalysis(snapshot, source) {
  const result = grammar.analyze(source, snapshot);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    source,
  );
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}
async function nativeReject(db, operation, label, constraint = false) {
  const rule = typeof constraint === "object" ? constraint : undefined;
  const count = () => db.queryable.all(`SELECT COUNT_BIG(*) AS row_count FROM ${rule.table}`);
  const before = rule ? await count() : undefined;
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  const observed = {
    label,
    code: failure?.code,
    diagnostics: failure?.diagnostics?.map(({ state, native }) => ({ state, native })),
  };
  if (rule) {
    rule.report.nativeRejections ??= [];
    rule.report.nativeRejections.push(observed);
    observed.before = before;
    observed.after = await count();
  }
  assert.ok(failure, `Native SQL must reject ${label}`);
  assert.equal(failure.code, "TSQL_ODBC_NATIVE", `A native rejection, not a local codec/transport error: ${label}`);
  assert.ok(Array.isArray(failure.diagnostics) && failure.diagnostics.length > 0);
  assert.ok(
    failure.diagnostics.every((diagnostic) => !diagnostic.state.startsWith("08")),
    `No connection-loss class for ${label}`,
  );
  if (rule) {
    assert.ok(
      failure.diagnostics.some((diagnostic) => diagnostic.native === 513),
      `Native bound-rule violation 513: ${label}`,
    );
    assert.deepEqual(observed.after, before, `Rejected rule insert must not mutate ${rule.table}`);
  } else if (constraint)
    assert.ok(
      failure.diagnostics.some((diagnostic) => diagnostic.state.startsWith("23")),
      `Native integrity-constraint SQLSTATE for ${label}`,
    );
  const reusable = await db.queryable.all("SELECT 1 AS reusable");
  assert.equal(reusable.length, 1);
  assert.equal(integer(reusable[0].reusable), 1);
  return failure.diagnostics.map(({ state, native }) => ({ state, native }));
}
const capture = (db) => new SqlServerSchemaProvider({ client: db.queryable, includeSchemas: ["dbo"] }).introspect();
async function columnFacts(db, table) {
  return db.queryable.all(
    `SELECT c.name,c.column_id,c.user_type_id,c.system_type_id,c.is_nullable,c.is_identity,c.is_computed,c.is_hidden,c.generated_always_type,c.default_object_id,c.rule_object_id,t.default_object_id AS type_default_id,t.rule_object_id AS type_rule_id,CASE WHEN OBJECT_DEFINITION(NULLIF(c.default_object_id,0)) IS NULL THEN 0 ELSE 1 END AS definition_visible FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID(${literal(`dbo.${table}`)}) ORDER BY c.column_id`,
  );
}
function compareBindings(column, native) {
  const facts = attributes(column);
  assert.equal(facts.columnId, integer(native.column_id));
  assert.equal(column.nullable, flag(native.is_nullable));
  for (const [key, source] of [
    ["defaultObjectId", "default_object_id"],
    ["ruleObjectId", "rule_object_id"],
    ["typeDefaultObjectId", "type_default_id"],
    ["typeRuleObjectId", "type_rule_id"],
  ])
    assert.equal(facts[key], integer(native[source]));
  assert.equal(
    column.default,
    integer(native.default_object_id) !== 0 ? "present" : integer(native.type_default_id) !== 0 ? "unknown" : "none",
  );
  if (integer(native.default_object_id) !== 0 && !flag(native.definition_visible))
    assert.equal(column.defaultExpressionHash, undefined);
}
async function aliases(db, report) {
  const q = (text) => db.queryable.all(text);
  await q("CREATE TYPE dbo.catalog_alias FROM bigint NOT NULL");
  await q("CREATE DEFAULT dbo.catalog_alias_default AS 7");
  await q("CREATE RULE dbo.catalog_alias_positive AS @value > 0");
  await q("EXEC sys.sp_bindefault N'dbo.catalog_alias_default',N'dbo.catalog_alias'");
  await q("EXEC sys.sp_bindrule N'dbo.catalog_alias_positive',N'dbo.catalog_alias'");
  await q(
    "CREATE TABLE dbo.catalog_columns(id bigint IDENTITY(11,7) NOT NULL PRIMARY KEY,inherited_value dbo.catalog_alias,nullable_override dbo.catalog_alias NULL,explicit_nonnull dbo.catalog_alias NOT NULL,amount decimal(38,10) NOT NULL DEFAULT(0),computed_virtual AS(id+1),computed_stored AS(id+2) PERSISTED,version_value rowversion)",
  );
  let snapshot = await capture(db);
  const type = snapshot.types["dbo.catalog_alias"],
    relation = snapshot.relations["dbo.catalog_columns"],
    columns = relation.columns;
  const nativeType = (
    await q(
      "SELECT user_type_id,system_type_id,is_nullable,default_object_id,rule_object_id FROM sys.types WHERE user_type_id=TYPE_ID(N'dbo.catalog_alias')",
    )
  )[0];
  report.observedType = nativeType;
  assert.ok(integer(nativeType.user_type_id) !== integer(nativeType.system_type_id));
  assert.equal(flag(nativeType.is_nullable), false);
  assert.equal(type.kind, "scalar");
  assert.equal(type.databaseType, "bigint");
  assert.equal(attributes(type).declaredNullable, false);
  assert.equal(attributes(type).defaultObjectId, integer(nativeType.default_object_id));
  assert.equal(attributes(type).ruleObjectId, integer(nativeType.rule_object_id));
  hash(attributes(type).boundDefaultHash);
  hash(attributes(type).boundRuleHash);
  const facts = await columnFacts(db, "catalog_columns");
  report.observedColumns = facts;
  for (const native of facts) compareBindings(columns[native.name], native);
  assert.equal(columns.inherited_value.nullable, false);
  assert.equal(columns.nullable_override.nullable, true);
  assert.equal(columns.explicit_nonnull.nullable, false);
  assert.equal(columns.inherited_value.typeIdentity, "dbo.catalog_alias");
  assert.equal(columns.id.identity, "always");
  assert.equal(attributes(columns.id).seed, "11");
  assert.equal(attributes(columns.id).increment, "7");
  assert.equal(columns.computed_virtual.generated, "virtual");
  assert.equal(columns.computed_stored.generated, "stored");
  hash(columns.computed_virtual.generatedExpressionHash);
  hash(columns.computed_stored.generatedExpressionHash);
  assert.equal(columns.version_value.databaseType, "rowversion");
  for (const name of ["id", "computed_virtual", "computed_stored", "version_value"]) {
    assert.equal(columns[name].insertable, false);
    assert.equal(columns[name].updatable, false);
  }
  const insert = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_columns(nullable_override,amount) OUTPUT inserted.id,inserted.inherited_value,inserted.nullable_override,inserted.explicit_nonnull,inserted.amount,inserted.computed_virtual,inserted.computed_stored,inserted.version_value VALUES(:nullable,:amount)",
  );
  const amount = "1234567890123456789012345678.1234567890";
  const first = await db.one(insert.factory({ nullable: null, amount }));
  assert.equal(first.id, 11n);
  assert.equal(first.inherited_value, 7n);
  assert.equal(first.nullable_override, null);
  assert.equal(first.explicit_nonnull, 7n);
  assert.equal(first.amount, amount);
  assert.equal(first.computed_virtual, 12n);
  assert.equal(first.computed_stored, 13n);
  assert.ok(first.version_value instanceof Uint8Array && first.version_value.length === 8);
  const version = (
    await q(
      "SELECT version_value,CONVERT(varbinary(8),version_value) AS native_bytes FROM dbo.catalog_columns WHERE id=11",
    )
  )[0];
  assert.deepEqual(version.version_value, version.native_bytes);
  assert.deepEqual(first.version_value, version.native_bytes);
  const bound = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_columns(inherited_value,nullable_override) OUTPUT inserted.inherited_value,inserted.nullable_override VALUES(:value,:nullable)",
  );
  assert.deepEqual(
    bound.plan.parameters.map((parameter) => [parameter.databaseType, parameter.nullable]),
    [
      ["bigint", false],
      ["bigint", true],
    ],
  );
  assert.deepEqual(await db.one(bound.factory({ value: 9223372036854775807n, nullable: null })), {
    inherited_value: 9223372036854775807n,
    nullable_override: null,
  });
  const ruleFailure = await nativeReject(
    db,
    () => db.one(bound.factory({ value: -1n, nullable: null })),
    "alias rule",
    { table: "dbo.catalog_columns", report },
  );
  for (const [source, native] of [
    ["INSERT INTO dbo.catalog_columns(id) VALUES(50)", "INSERT INTO dbo.catalog_columns(id) VALUES(50)"],
    ["UPDATE dbo.catalog_columns SET computed_virtual=1", "UPDATE dbo.catalog_columns SET computed_virtual=1"],
    [
      "UPDATE dbo.catalog_columns SET version_value=0x0102030405060708",
      "UPDATE dbo.catalog_columns SET version_value=0x0102030405060708",
    ],
  ]) {
    rejectsAnalysis(snapshot, source);
    await nativeReject(db, () => q(native), source);
  }
  await q("CREATE DEFAULT dbo.catalog_column_default AS 13");
  await q("CREATE RULE dbo.catalog_column_rule AS @value >= 10");
  await q("EXEC sys.sp_bindefault N'dbo.catalog_column_default',N'dbo.catalog_columns.nullable_override'");
  await q("EXEC sys.sp_bindrule N'dbo.catalog_column_rule',N'dbo.catalog_columns.nullable_override'");
  snapshot = await capture(db);
  const overridden = snapshot.relations["dbo.catalog_columns"].columns.nullable_override;
  const overrideNative = (await columnFacts(db, "catalog_columns")).find((row) => row.name === "nullable_override");
  compareBindings(overridden, overrideNative);
  assert.notEqual(integer(overrideNative.default_object_id), integer(overrideNative.type_default_id));
  assert.notEqual(integer(overrideNative.rule_object_id), integer(overrideNative.type_rule_id));
  hash(overridden.defaultExpressionHash);
  hash(attributes(overridden).boundRuleHash);
  const omitted = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_columns(amount) OUTPUT inserted.inherited_value,inserted.nullable_override VALUES(:amount)",
  );
  assert.deepEqual(await db.one(omitted.factory({ amount: "0.0000000000" })), {
    inherited_value: 7n,
    nullable_override: 13n,
  });
  await nativeReject(
    db,
    () => q("INSERT INTO dbo.catalog_columns(nullable_override) VALUES(5)"),
    "column rule overrides alias rule",
    { table: "dbo.catalog_columns", report },
  );
  await q("EXEC sys.sp_unbindefault N'dbo.catalog_alias'");
  await q("EXEC sys.sp_unbindrule N'dbo.catalog_alias'");
  snapshot = await capture(db);
  const unbound = snapshot.relations["dbo.catalog_columns"].columns;
  assert.equal(attributes(snapshot.types["dbo.catalog_alias"]).defaultObjectId, 0);
  assert.equal(attributes(snapshot.types["dbo.catalog_alias"]).ruleObjectId, 0);
  assert.equal(unbound.inherited_value.default, "none");
  assert.equal(attributes(unbound.inherited_value).ruleObjectId, 0);
  assert.equal(unbound.nullable_override.default, "present");
  assert.ok(attributes(unbound.nullable_override).ruleObjectId > 0);
  const supplied = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_columns(inherited_value,explicit_nonnull) OUTPUT inserted.nullable_override VALUES(:value,:other)",
  );
  assert.deepEqual(await db.one(supplied.factory({ value: 3n, other: 4n })), { nullable_override: 13n });
  await q("EXEC sys.sp_unbindefault N'dbo.catalog_columns.nullable_override'");
  await q("EXEC sys.sp_unbindrule N'dbo.catalog_columns.nullable_override'");
  snapshot = await capture(db);
  assert.equal(snapshot.relations["dbo.catalog_columns"].columns.nullable_override.default, "none");
  const noDefault = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_columns(inherited_value,explicit_nonnull) OUTPUT inserted.nullable_override VALUES(:value,:other)",
  );
  assert.deepEqual(await db.one(noDefault.factory({ value: -3n, other: -4n })), { nullable_override: null });
  report.native = {
    type: nativeType,
    columns: facts,
    columnOverride: overrideNative,
    ruleFailure,
    finalBindings: await columnFacts(db, "catalog_columns"),
  };
}
async function futureOnly(db, report) {
  const q = (text) => db.queryable.all(text);
  await q("CREATE TYPE dbo.catalog_future_alias FROM bigint NOT NULL");
  await q("CREATE TABLE dbo.catalog_before(id int NOT NULL PRIMARY KEY,value dbo.catalog_future_alias)");
  await q("CREATE DEFAULT dbo.catalog_future_default AS 17");
  await q("CREATE RULE dbo.catalog_future_rule AS @value > 0");
  await q("EXEC sys.sp_bindefault N'dbo.catalog_future_default',N'dbo.catalog_future_alias',N'futureonly'");
  await q("EXEC sys.sp_bindrule N'dbo.catalog_future_rule',N'dbo.catalog_future_alias',N'futureonly'");
  await q("CREATE TABLE dbo.catalog_after(id int NOT NULL PRIMARY KEY,value dbo.catalog_future_alias)");
  const before = (await columnFacts(db, "catalog_before")).find((row) => row.name === "value"),
    after = (await columnFacts(db, "catalog_after")).find((row) => row.name === "value");
  report.observedBindings = { before, after };
  assert.equal(integer(before.default_object_id), 0);
  assert.equal(integer(before.rule_object_id), 0);
  assert.ok(integer(before.type_default_id) > 0 && integer(before.type_rule_id) > 0);
  assert.equal(integer(after.default_object_id), integer(after.type_default_id));
  assert.equal(integer(after.rule_object_id), integer(after.type_rule_id));
  const snapshot = await capture(db);
  compareBindings(snapshot.relations["dbo.catalog_before"].columns.value, before);
  compareBindings(snapshot.relations["dbo.catalog_after"].columns.value, after);
  assert.equal(snapshot.relations["dbo.catalog_before"].columns.value.default, "unknown");
  assert.equal(snapshot.relations["dbo.catalog_after"].columns.value.default, "present");
  await nativeReject(
    db,
    () => q("INSERT INTO dbo.catalog_before(id) VALUES(2)"),
    "futureonly does not install old column default",
    true,
  );
  const oldInsert = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_before(id,value) OUTPUT inserted.value VALUES(:id,:value)",
  );
  assert.deepEqual(await db.one(oldInsert.factory({ id: 1, value: -1n })), { value: -1n });
  const newInsert = await compiled(snapshot, "INSERT INTO dbo.catalog_after(id) OUTPUT inserted.value VALUES(:id)");
  assert.deepEqual(await db.one(newInsert.factory({ id: 1 })), { value: 17n });
  const newBound = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_after(id,value) OUTPUT inserted.value VALUES(:id,:value)",
  );
  const ruleFailure = await nativeReject(
    db,
    () => db.one(newBound.factory({ id: 2, value: -1n })),
    "futureonly new-column rule",
    { table: "dbo.catalog_after", report },
  );
  report.native = {
    before,
    after,
    ruleFailure,
    oldValues: await q("SELECT value FROM dbo.catalog_before"),
    newValues: await q("SELECT value FROM dbo.catalog_after"),
  };
}
async function temporal(db, report) {
  const q = (text) => db.queryable.all(text);
  await q(
    "CREATE TABLE dbo.catalog_temporal(id bigint NOT NULL PRIMARY KEY,status nvarchar(40) NOT NULL,valid_from datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,valid_to datetime2(7) GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,PERIOD FOR SYSTEM_TIME(valid_from,valid_to)) WITH(SYSTEM_VERSIONING=ON(HISTORY_TABLE=dbo.catalog_history))",
  );
  let snapshot = await capture(db);
  const current = snapshot.relations["dbo.catalog_temporal"],
    history = snapshot.relations["dbo.catalog_history"];
  const native = await q(
    "SELECT o.name,t.object_id,t.temporal_type,t.history_table_id,p.start_column_id,p.end_column_id FROM sys.tables t JOIN sys.objects o ON o.object_id=t.object_id LEFT JOIN sys.periods p ON p.object_id=t.object_id WHERE o.name IN(N'catalog_temporal',N'catalog_history') ORDER BY o.name",
  );
  report.observedTables = native;
  assert.equal(attributes(current).temporalType, 2);
  assert.equal(attributes(history).temporalType, 1);
  assert.equal(attributes(current).historyTableId, attributes(history).objectId);
  assert.equal(
    integer(native.find((row) => row.name === "catalog_temporal").history_table_id),
    attributes(history).objectId,
  );
  assert.equal(current.columns.valid_from.position, 2);
  assert.equal(current.columns.valid_to.position, 3);
  for (const [name, always] of [
    ["valid_from", 1],
    ["valid_to", 2],
  ]) {
    assert.equal(current.columns[name].classification, "hidden");
    assert.equal(attributes(current.columns[name]).generatedAlwaysType, always);
    assert.equal(current.columns[name].insertable, false);
    assert.equal(current.columns[name].updatable, false);
  }
  for (const capability of ["insertable", "updatable", "deletable"]) {
    assert.equal(current.capabilities[capability], true);
    assert.equal(history.capabilities[capability], false);
  }
  for (const column of Object.values(history.columns)) {
    assert.equal(column.insertable, false);
    assert.equal(column.updatable, false);
  }
  const insert = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_temporal(id,status) OUTPUT inserted.id,inserted.status VALUES(:id,:status)",
  );
  assert.deepEqual(await db.one(insert.factory({ id: 1n, status: "new😀" })), { id: 1n, status: "new😀" });
  assert.deepEqual(Object.keys((await q("SELECT * FROM dbo.catalog_temporal"))[0]), ["id", "status"]);
  assert.deepEqual(
    grammar.analyze("SELECT * FROM dbo.catalog_temporal", snapshot).columns.map((column) => column.name),
    ["id", "status"],
  );
  const asof = (await q("SELECT CONVERT(varchar(33),SYSUTCDATETIME(),126) AS instant"))[0].instant;
  assert.match(asof, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?$/u);
  await q("WAITFOR DELAY '00:00:00.020'");
  const update = await compiled(
    snapshot,
    "UPDATE dbo.catalog_temporal SET status=:status OUTPUT inserted.id,inserted.status WHERE id=:id",
  );
  assert.deepEqual(await db.one(update.factory({ id: 1n, status: "changed" })), { id: 1n, status: "changed" });
  const nativeAsOf = await q(
    `SELECT id,status FROM dbo.catalog_temporal FOR SYSTEM_TIME AS OF ${literal(asof)} WHERE id=1`,
  );
  // The raw queryable intentionally returns counted numeric text; only compiled
  // query execution promises the grammar's bigint decoder. Preserve the raw wire
  // observation in the artifact and canonicalize this independent SQL oracle.
  report.nativeAsOf = nativeAsOf;
  assert.equal(nativeAsOf.length, 1);
  assert.equal(BigInt(nativeAsOf[0].id), 1n);
  assert.equal(nativeAsOf[0].status, "new😀");
  const selected = await compiled(
    snapshot,
    "SELECT id,status,valid_from,valid_to FROM dbo.catalog_temporal FOR SYSTEM_TIME AS OF :instant WHERE id=:id",
  );
  // This exercises the original grammar context through native parameter lowering,
  // rather than treating prepare/describe metadata as proof that AS OF executes.
  try {
    const typedAsOf = await db.one(selected.factory({ instant: asof, id: 1n }));
    assert.equal(typedAsOf.id, 1n);
    assert.equal(typedAsOf.status, "new😀");
  } catch (error) {
    // Preserve later history/write/detach observations even if contextual parameter
    // lowering exposes a native counterexample. The probe still fails overall.
    report.counterexamples = [
      { name: "compiled FOR SYSTEM_TIME AS OF parameter", error: redact(error), diagnostics: error?.diagnostics },
    ];
    failures.push(`${report.compatibilityLevel}: compiled FOR SYSTEM_TIME AS OF parameter`);
  }
  const activeFailures = [];
  for (const source of [
    "UPDATE dbo.catalog_temporal SET valid_from='2020-01-01' WHERE id=1",
    "INSERT INTO dbo.catalog_history(id,status,valid_from,valid_to) VALUES(99,N'bad','2020-01-01','2021-01-01')",
    "UPDATE dbo.catalog_history SET status=N'bad' WHERE id=1",
    "DELETE FROM dbo.catalog_history WHERE id=1",
  ]) {
    rejectsAnalysis(snapshot, source);
    activeFailures.push(await nativeReject(db, () => q(source), "active temporal write restriction"));
  }
  const remove = await compiled(
    snapshot,
    "DELETE FROM dbo.catalog_temporal OUTPUT deleted.id,deleted.status WHERE id=:id",
  );
  assert.deepEqual(await db.one(remove.factory({ id: 1n })), { id: 1n, status: "changed" });
  await q("ALTER TABLE dbo.catalog_temporal SET(SYSTEM_VERSIONING=OFF)");
  snapshot = await capture(db);
  const detached = snapshot.relations["dbo.catalog_history"];
  assert.equal(attributes(detached).temporalType, 0);
  for (const capability of ["insertable", "updatable", "deletable"])
    assert.equal(detached.capabilities[capability], true);
  for (const column of Object.values(detached.columns)) {
    assert.equal(column.insertable, true);
    assert.equal(column.updatable, true);
  }
  const detachedInsert = await compiled(
    snapshot,
    "INSERT INTO dbo.catalog_history(id,status,valid_from,valid_to) OUTPUT inserted.id,inserted.status VALUES(:id,:status,:start,:end)",
  );
  assert.deepEqual(
    await db.one(
      detachedInsert.factory({
        id: 99n,
        status: "detached",
        start: "2020-01-01T00:00:00.0000000",
        end: "2021-01-01T00:00:00.0000000",
      }),
    ),
    { id: 99n, status: "detached" },
  );
  const detachedUpdate = await compiled(
    snapshot,
    "UPDATE dbo.catalog_history SET status=:status OUTPUT inserted.id WHERE id=:id",
  );
  assert.deepEqual(await db.one(detachedUpdate.factory({ id: 99n, status: "updated" })), { id: 99n });
  const detachedDelete = await compiled(snapshot, "DELETE FROM dbo.catalog_history OUTPUT deleted.id WHERE id=:id");
  assert.deepEqual(await db.one(detachedDelete.factory({ id: 99n })), { id: 99n });
  rejectsAnalysis(snapshot, "SELECT id FROM dbo.catalog_temporal FOR SYSTEM_TIME AS OF '2020-01-01'");
  report.native = {
    tables: native,
    currentColumns: await columnFacts(db, "catalog_temporal"),
    historyColumns: await columnFacts(db, "catalog_history"),
    activeFailures,
    nativeAsOf,
    detachedTemporalType: attributes(detached).temporalType,
  };
}
async function commerce(db, report) {
  await db.queryable.all(
    await readFile(new URL("../../examples/sqlserver/schema/001-schema.sql", import.meta.url), "utf8"),
  );
  const names = ["users", "teams", "memberships", "products", "orders", "order_items", "audit_events"];
  const native = await db.queryable.all(
    "SELECT name FROM sys.tables WHERE name IN(N'users',N'teams',N'memberships',N'products',N'orders',N'order_items',N'audit_events') ORDER BY name",
  );
  assert.deepEqual(
    native.map((row) => row.name),
    [...names].sort(),
  );
  const snapshot = await capture(db);
  for (const name of names) assert.equal(snapshot.relations[`dbo.${name}`].kind, "table");
  const nativeIndex = await db.queryable.all(
    "SELECT c.name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE i.object_id=OBJECT_ID(N'dbo.orders') AND i.name=N'orders_user_placed' ORDER BY ic.index_column_id",
  );
  report.observedIndex = nativeIndex;
  assert.deepEqual(
    nativeIndex.filter((row) => !flag(row.is_included_column)).map((row) => [row.name, flag(row.is_descending_key)]),
    [
      ["user_id", false],
      ["placed_at", true],
    ],
  );
  assert.deepEqual(
    nativeIndex.filter((row) => flag(row.is_included_column)).map((row) => row.name),
    ["status", "total_cents"],
  );
  const index = snapshot.relations["dbo.orders"].indexes.find((index) => index.name === "orders_user_placed");
  assert.deepEqual(
    index.columns.map((column) => [column.column, column.descending]),
    [
      ["user_id", false],
      ["placed_at", true],
    ],
  );
  assert.deepEqual(index.includedColumns, ["status", "total_cents"]);
  const joined = await compiled(
    snapshot,
    "SELECT o.id,u.email,SUM(i.quantity*i.unit_price_cents) AS total_cents FROM dbo.orders o JOIN dbo.users u ON u.id=o.user_id JOIN dbo.order_items i ON i.order_id=o.id WHERE o.id=:id GROUP BY o.id,u.email",
  );
  assert.deepEqual(await db.all(joined.factory({ id: 9001n })), [
    { id: 9001n, email: "ada@example.com", total_cents: 3298 },
  ]);
  report.native = { tables: native, index: nativeIndex, orderId: "9001", totalCents: 3298 };
}
async function permissions(db, report) {
  const q = (text) => db.queryable.all(text);
  await q(
    "CREATE TABLE dbo.catalog_visible(id int NOT NULL PRIMARY KEY,value int NOT NULL CONSTRAINT catalog_visible_default DEFAULT(123))",
  );
  await q("CREATE TABLE dbo.catalog_invisible(id int NOT NULL)");
  await q("CREATE FUNCTION dbo.catalog_visible_function() RETURNS int AS BEGIN RETURN 123 END");
  await q("CREATE USER catalog_reader WITHOUT LOGIN WITH DEFAULT_SCHEMA=dbo");
  await q("GRANT VIEW DEFINITION TO catalog_reader");
  await q("GRANT SELECT ON OBJECT::dbo.catalog_visible TO catalog_reader");
  await q("GRANT EXECUTE ON OBJECT::dbo.catalog_visible_function TO catalog_reader");
  const owner = await capture(db),
    ownerNames = Object.keys(owner.relations).sort();
  assert.equal(owner.routines["dbo.catalog_visible_function"]?.length, 1);
  await q("DENY VIEW DEFINITION ON OBJECT::dbo.catalog_visible_function TO catalog_reader");
  await q("DENY VIEW DEFINITION ON OBJECT::dbo.catalog_invisible TO catalog_reader");
  await q("DENY VIEW DEFINITION ON OBJECT::dbo.catalog_visible TO catalog_reader");
  let restricted;
  await q("EXECUTE AS USER=N'catalog_reader'");
  try {
    const effective = (
      await q(
        "SELECT HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION') AS database_view,HAS_PERMS_BY_NAME('dbo.catalog_visible_function','OBJECT','VIEW DEFINITION') AS function_view",
      )
    )[0];
    report.effectivePermissions = effective;
    assert.equal(integer(effective.database_view), 1);
    assert.equal(integer(effective.function_view), 0);
    const routine = (
      await q(
        "SELECT OBJECT_ID(N'dbo.catalog_visible_function') AS object_id,CASE WHEN OBJECT_DEFINITION(OBJECT_ID(N'dbo.catalog_visible_function')) IS NULL THEN 1 ELSE 0 END AS unavailable,CASE WHEN EXISTS(SELECT 1 FROM sys.sql_modules WHERE object_id=OBJECT_ID(N'dbo.catalog_visible_function')) THEN 1 ELSE 0 END AS module_row_visible",
      )
    )[0];
    report.definitionVisibility = routine;
    assert.equal(integer(routine.unavailable), 1);
    // DENY VIEW DEFINITION can hide the object row and OBJECT_ID despite an
    // independent permission to invoke it. Prove invocation separately from catalog visibility.
    const invoked = await q("SELECT dbo.catalog_visible_function() AS permitted_result");
    report.permittedInvocation = invoked;
    assert.equal(invoked.length, 1);
    assert.equal(integer(invoked[0].permitted_result), 123);
    const visibleColumns = await columnFacts(db, "catalog_visible");
    report.restrictedColumns = visibleColumns;
    const defaultFact = visibleColumns.find((row) => row.name === "value");
    restricted = await capture(db);
    const visibleRelation = restricted.relations["dbo.catalog_visible"];
    if (defaultFact) {
      assert.ok(integer(defaultFact.default_object_id) > 0);
      assert.ok(visibleRelation, "Provider retains a natively visible table");
      compareBindings(visibleRelation.columns.value, defaultFact);
    } else {
      assert.equal(visibleRelation, undefined, "Provider must not invent a table hidden from native catalogs");
    }
    const routineSnapshot = restricted.routines["dbo.catalog_visible_function"]?.[0];
    if (routine.object_id === null) {
      assert.equal(routineSnapshot, undefined, "Provider must not invent a routine hidden from native catalogs");
    } else {
      assert.ok(integer(routine.object_id) > 0);
      assert.ok(routineSnapshot, "Provider retains the natively visible routine");
      assert.equal(attributes(routineSnapshot).definitionUnavailable, true);
    }
    const omitted = ownerNames.filter((name) => !restricted.relations[name]);
    report.visibility = {
      effective,
      routineObjectVisible: routine.object_id !== null,
      routineOmitted: routineSnapshot === undefined,
      tableColumnsVisible: visibleColumns.length > 0,
      definitionUnavailable: true,
      defaultFact,
      ownerRelationCount: ownerNames.length,
      restrictedRelationCount: Object.keys(restricted.relations).length,
      omittedOwnerRelations: omitted,
      completeCatalog: false,
    };
    evidence.limitations.push({
      compatibilityLevel: report.compatibilityLevel,
      kind: "metadata-visibility",
      providerReturnedSnapshotWithObjectDenials: true,
      omittedOwnerRelations: omitted,
      definitionUnavailable: true,
      completeCatalog: false,
    });
  } finally {
    await q("REVERT");
  }
  await q("REVOKE VIEW DEFINITION FROM catalog_reader");
  await q("EXECUTE AS USER=N'catalog_reader'");
  try {
    const actual = (await q("SELECT HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION') AS allowed"))[0];
    assert.equal(integer(actual.allowed), 0);
    await assert.rejects(capture(db), /VIEW DEFINITION/u);
  } finally {
    await q("REVERT");
  }
}

let admin;
const owned = new Set();
try {
  admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
  assert.equal(admin.serverEvidence.version, build);
  for (const compatibilityLevel of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    const database = `typed_sql_catalog_${major}_${compatibilityLevel}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const profile = { compatibilityLevel, database, cases: [] };
    evidence.profiles.push(profile);
    await admin.queryable.all(`CREATE DATABASE ${quote(database)} COLLATE SQL_Latin1_General_CP1_CI_AS`);
    owned.add(database);
    await admin.queryable.all(`ALTER DATABASE ${quote(database)} SET COMPATIBILITY_LEVEL=${compatibilityLevel}`);
    const db = await createSqlServerOdbcDatabase({ connectionString: dsn(database) });
    try {
      const native = (
        await db.queryable.all(
          "SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS version,d.compatibility_level,DB_NAME() AS database_name FROM sys.databases d WHERE d.database_id=DB_ID()",
        )
      )[0];
      assert.equal(native.version, build);
      assert.equal(integer(native.compatibility_level), compatibilityLevel);
      assert.equal(native.database_name, database);
      profile.server = native;
      for (const [name, operation] of [
        ["aliases/defaults/rules/generated/rowversion", aliases],
        ["futureonly", futureOnly],
        ["temporal current/history/detach", temporal],
        ["seven-table commerce intake", commerce],
        ["restricted metadata visibility", permissions],
      ]) {
        const result = { name, compatibilityLevel },
          started = Date.now();
        profile.cases.push(result);
        try {
          await operation(db, result);
          result.status = result.counterexamples?.length ? "fail" : "pass";
        } catch (error) {
          result.status = "fail";
          result.error = redact(error);
          result.diagnostics = error?.diagnostics;
          failures.push(`${compatibilityLevel}: ${name}`);
        }
        result.durationMs = Date.now() - started;
      }
    } finally {
      try {
        await db.queryable.all(
          "IF EXISTS(SELECT 1 FROM sys.tables WHERE object_id=OBJECT_ID(N'dbo.catalog_temporal') AND temporal_type=2) ALTER TABLE dbo.catalog_temporal SET(SYSTEM_VERSIONING=OFF)",
        );
      } catch (error) {
        profile.cleanupError = redact(error);
      }
      try {
        await db.close();
      } catch (error) {
        profile.nativeCloseError = redact(error);
        failures.push(`${compatibilityLevel}: native close`);
      }
    }
    await admin.queryable.all(`ALTER DATABASE ${quote(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
    await admin.queryable.all(`DROP DATABASE ${quote(database)}`);
    owned.delete(database);
  }
} finally {
  if (admin) {
    for (const database of owned) {
      try {
        await admin.queryable.all(`ALTER DATABASE ${quote(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
        await admin.queryable.all(`DROP DATABASE ${quote(database)}`);
      } catch (error) {
        evidence.limitations.push({ kind: "cleanup-failure", database, error: redact(error) });
      }
    }
    try {
      await admin.close();
    } catch (error) {
      evidence.limitations.push({ kind: "admin-close-failure", error: redact(error) });
      failures.push("admin close");
    }
  }
  await mkdir(new URL("../../artifacts/sqlserver/", import.meta.url), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(evidence, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
  );
  await rm(generated, { recursive: true, force: true });
}
assert.deepEqual(failures, [], "Native catalog qualification has unresolved counterexamples; inspect catalog evidence");
console.log(
  JSON.stringify({
    major,
    profiles: evidence.profiles.length,
    cases: evidence.profiles.reduce((count, profile) => count + profile.cases.length, 0),
    limitations: evidence.limitations.length,
  }),
);
