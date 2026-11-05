import { describe, it, strict } from "poku";
import {
  introspectSqlServer,
  sqlServerCatalogQueries as query,
  readSqlServerServerEvidence,
  SqlServerSchemaProvider,
} from "../src/provider.js";
import { fixture } from "./helpers/catalog-fixture.js";

type Row = Record<string, unknown>;
await describe("SQL Server native catalog classifications and validation", async () => {
  await it("retains alias/CLR/table types, native dimensions, encryption, views and table routines", async () => {
    const state = fixture(),
      types = state.data.get(query.types)!,
      base = types[0]!,
      column = state.data.get(query.columns)![0]!;
    const scalar = (id: number, name: string, length: number, precision = 0, scale = 0): Row => ({
      ...base,
      user_type_id: id,
      system_type_id: id,
      type_name: name,
      base_name: name,
      max_length: length,
      precision,
      scale,
    });
    state.data.set(query.types, [
      ...types,
      scalar(42, "datetime2", 8, 27, 7),
      scalar(62, "float", 8, 53),
      scalar(106, "decimal", 9, 12, 2),
      scalar(165, "varbinary", -1),
      scalar(239, "nchar", 20),
      { ...scalar(240, "geometry", -1), is_assembly_type: true, base_name: null },
      {
        ...scalar(501, "LineIds", -1),
        schema_name: "dbo",
        system_type_id: 243,
        base_name: null,
        is_user_defined: true,
        is_table_type: true,
      },
    ]);
    state.data.set(query.columns, [
      ...state.data.get(query.columns)!,
      ...[
        ["moment", 42, 8, 27, 7],
        ["score", 62, 8, 53, 0],
        ["price", 106, 9, 12, 2],
        ["bytes", 165, -1, 0, 0],
        ["fixed", 239, 20, 0, 0],
        ["shape", 240, -1, 0, 0],
      ].map(([name, id, length, precision, scale], index) => ({
        ...column,
        column_id: index + 10,
        column_name: name,
        user_type_id: id,
        system_type_id: id,
        max_length: length,
        precision,
        scale,
        is_identity: false,
        is_nullable: true,
        collation_name: name === "fixed" ? "Latin1_General_100_CI_AS" : null,
        code_page: name === "fixed" ? 1252 : null,
      })),
      { ...column, column_id: 20, column_name: "protected", is_identity: false, encryption_type: 1, is_masked: true },
      {
        ...column,
        column_id: 21,
        column_name: "row_start",
        user_type_id: 42,
        system_type_id: 42,
        scale: 7,
        is_hidden: true,
        is_identity: false,
        generated_always_type: 1,
      },
      { ...column, object_id: 200, column_name: "view_id", is_identity: false },
      { ...column, object_id: 301, column_name: "result_id", is_identity: false },
    ]);
    state.data.set(query.relations, [
      ...state.data.get(query.relations)!,
      {
        schema_name: "dbo",
        object_name: "order_view",
        object_id: 200,
        object_type: "V ",
        temporal_type: null,
        history_table_id: null,
        is_memory_optimized: null,
        is_filetable: null,
        enabled_after_trigger: false,
      },
      { ...state.data.get(query.relations)![0], schema_name: "excluded", object_name: "hidden" },
    ]);
    const routine = state.data.get(query.routines)![0]!,
      parameter = state.data.get(query.parameters)![1]!;
    state.data.set(query.routines, [
      routine,
      { ...routine, object_id: 301, routine_name: "lines", object_type: "IF" },
      {
        ...routine,
        object_id: 302,
        routine_name: "do_work",
        object_type: "P",
        deterministic: null,
        is_schema_bound: null,
        null_on_null_input: null,
        definition_unavailable: true,
      },
      {
        ...routine,
        object_id: 303,
        routine_name: "opaque_result",
        object_type: "FS",
        deterministic: null,
        is_schema_bound: null,
        null_on_null_input: null,
        definition_unavailable: true,
      },
      { ...routine, schema_name: "excluded" },
    ]);
    state.data.set(query.parameters, [
      ...state.data.get(query.parameters)!,
      { ...parameter, object_id: 302, parameter_name: "@result", is_output: true, has_default_value: true },
    ]);
    const snapshot = await introspectSqlServer({ client: state.client, includeSchemas: ["dbo"] });
    strict.equal(snapshot.types["sys.geometry"]?.kind, "opaque");
    strict.equal(snapshot.types["dbo.LineIds"]?.kind, "opaque");
    const columns = snapshot.relations["dbo.orders"]!.columns;
    strict.equal(columns.moment?.databaseType, "datetime2(7)");
    strict.equal(columns.score?.databaseType, "float(53)");
    strict.equal(columns.price?.databaseType, "decimal(12,2)");
    strict.equal(columns.bytes?.databaseType, "varbinary(max)");
    strict.equal(columns.fixed?.databaseType, "nchar(10)");
    strict.equal(columns.shape?.tsType, "unknown");
    strict.equal(columns.protected?.tsType, "unknown");
    strict.equal(columns.protected?.insertable, false);
    strict.equal(columns.row_start?.classification, "hidden");
    strict.equal(columns.row_start?.updatable, false);
    strict.equal(snapshot.relations["dbo.order_view"]?.columns.view_id?.updatable, "unknown");
    strict.equal(snapshot.relations["excluded.hidden"], undefined);
    strict.equal(snapshot.routines["dbo.lines"]?.[0]?.result.kind, "table");
    strict.equal(snapshot.routines["dbo.do_work"]?.[0]?.result.kind, "command");
    strict.equal(snapshot.routines["dbo.do_work"]?.[0]?.arguments[0]?.mode, "inout");
    strict.equal(snapshot.routines["dbo.do_work"]?.[0]?.arguments[0]?.default, "present");
    strict.equal(snapshot.routines["dbo.opaque_result"]?.[0]?.result.kind, "scalar");
    strict.equal(snapshot.routines["dbo.opaque_result"]?.[0]?.nullInput, "unknown");
  });
  await it("preserves ordered foreign keys, SQL Server NULL uniqueness and disabled filtered indexes", async () => {
    const state = fixture(),
      base = state.data.get(query.constraints)![0]!;
    state.data.set(query.constraints, [
      { ...base, constraint_id: 202, constraint_type: "UQ", name: "UQ_status", column_name: "status" },
      {
        ...base,
        constraint_id: 203,
        constraint_type: "F",
        name: "FK_self",
        column_name: "id",
        referenced_schema: "dbo",
        referenced_table: "orders",
        referenced_column: "id",
        update_action: "NO_ACTION",
        delete_action: "CASCADE",
      },
      {
        ...base,
        constraint_id: 204,
        constraint_type: "C",
        name: "CK_hidden",
        column_name: null,
        definition: null,
        is_disabled: true,
        is_not_trusted: true,
      },
    ]);
    state.data.set(query.indexes, [
      {
        ...state.data.get(query.indexes)![0],
        has_filter: false,
        filter_definition: null,
        is_disabled: true,
        is_hypothetical: true,
      },
    ]);
    const snapshot = await new SqlServerSchemaProvider({ client: state.client }).introspect();
    const relation = snapshot.relations["dbo.orders"]!,
      unique = relation.constraints[0]!,
      foreign = relation.constraints[1]!;
    strict.equal(unique.kind, "unique");
    if (unique.kind === "unique") strict.equal(unique.nullsDistinct, false);
    strict.equal(foreign.kind, "foreign-key");
    if (foreign.kind === "foreign-key") {
      strict.equal(foreign.referencedRelation, "dbo.orders");
      strict.deepEqual(foreign.referencedColumns, ["id"]);
      strict.equal(foreign.onDelete, "cascade");
      strict.equal(foreign.onUpdate, "no-action");
    }
    strict.equal(relation.constraints[2]?.extension?.attributes.enabled, false);
    strict.equal(relation.indexes[0]?.valid, false);
    strict.equal(relation.indexes[0]?.predicate, "none");
  });
  await it("rejects malformed catalog values and incomplete session discovery", async () => {
    strict.throws(() => new SqlServerSchemaProvider({ includeSchemas: [""] }), /bounded/);
    for (const [catalog, key, value] of [
      [query.server, "version", null],
      [query.server, "engine_edition", "not-an-int"],
      [query.server, "can_view_definition", "yes"],
      [query.columns, "column_id", 1.5],
      [query.columns, "is_nullable", null],
      [query.constraints, "constraint_type", "unmodeled"],
    ] as const) {
      const state = fixture();
      state.data.set(catalog, [{ ...state.data.get(catalog)![0], [key]: value }]);
      await strict.rejects(new SqlServerSchemaProvider({ client: state.client }).introspect());
    }
    const missing = fixture();
    missing.data.set(query.server, []);
    await strict.rejects(readSqlServerServerEvidence(missing.client), /no server/);
    const options = fixture();
    options.data.set(query.options, []);
    await strict.rejects(readSqlServerServerEvidence(options.client), /dateformat/);
  });
});
