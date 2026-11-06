import { strict } from "poku";
import { sqlServerCatalogQueries as queries, type SqlServerQueryable } from "../../src/provider.js";

type Row = Record<string, unknown>;
export function fixture() {
  const type = (user_type_id: number, name: string, max_length: number, precision = 0, scale = 0) => ({
    schema_name: "sys",
    type_name: name,
    user_type_id,
    system_type_id: user_type_id,
    is_user_defined: false,
    is_assembly_type: false,
    is_table_type: false,
    base_name: name,
    max_length,
    precision,
    scale,
    is_nullable: true,
    default_object_id: 0,
    rule_object_id: 0,
    bound_default_expression: null,
    bound_rule_expression: null,
  });
  const column = (name: string, id: number, typeId: number, extra: Row = {}) => ({
    object_id: 100,
    column_id: id,
    column_name: name,
    user_type_id: typeId,
    system_type_id: typeId,
    max_length: typeId === 231 ? 40 : 8,
    precision: typeId === 127 ? 19 : 0,
    scale: 0,
    is_nullable: false,
    is_identity: false,
    is_computed: false,
    is_hidden: false,
    generated_always_type: 0,
    is_sparse: false,
    is_column_set: false,
    collation_name: typeId === 231 ? "SQL_Latin1_General_CP1_CI_AS" : null,
    code_page: typeId === 231 ? 1252 : null,
    encryption_type: null,
    is_masked: false,
    is_persisted: false,
    generation_expression: null,
    default_expression: null,
    type_default_object_id: 0,
    type_rule_object_id: 0,
    default_object_id: 0,
    rule_object_id: 0,
    bound_rule_expression: null,
    identity_seed: null,
    identity_increment: null,
    ...extra,
  });
  const data = new Map<string, readonly Row[]>([
    [
      queries.server,
      [
        {
          version: "17.0.5035.5",
          edition: "Developer Edition",
          engine_edition: 3,
          database_name: "commerce",
          default_schema: "dbo",
          compatibility_level: 170,
          collation_name: "SQL_Latin1_General_CP1_CI_AS",
          quoted_identifier: 1,
          ansi_warnings: 1,
          arith_abort: 1,
          concat_null_on: 1,
          date_first: 7,
          language: "us_english",
          can_view_definition: 1,
        },
      ],
    ],
    [queries.options, [{ "Set Option": "dateformat", Value: "mdy" }]],
    [queries.schemas, [{ name: "dbo" }]],
    [
      queries.types,
      [
        type(127, "bigint", 8, 19),
        type(231, "nvarchar", -1),
        type(98, "sql_variant", 8016),
        {
          ...type(500, "OrderId", 8, 19),
          schema_name: "dbo",
          system_type_id: 127,
          is_user_defined: true,
          base_name: "bigint",
        },
      ],
    ],
    [
      queries.relations,
      [
        {
          schema_name: "dbo",
          object_name: "orders",
          object_id: 100,
          object_type: "U",
          temporal_type: 2,
          history_table_id: 101,
          is_memory_optimized: false,
          is_filetable: false,
          enabled_after_trigger: true,
        },
      ],
    ],
    [
      queries.columns,
      [
        column("id", 1, 127, { is_identity: true, identity_seed: "1", identity_increment: "1" }),
        column("status", 2, 231, { default_expression: "(N'new')" }),
        column("label", 4, 231, { is_computed: true, is_persisted: true, generation_expression: "([status]+N'!')" }),
      ],
    ],
    [
      queries.constraints,
      [
        {
          object_id: 100,
          constraint_id: 200,
          name: "PK_orders",
          constraint_type: "PK",
          ordinal: 1,
          column_name: "id",
          is_disabled: false,
          is_not_trusted: false,
        },
        {
          object_id: 100,
          constraint_id: 201,
          name: "CK_orders",
          constraint_type: "C",
          ordinal: 0,
          column_name: null,
          definition: "([id]>(0))",
          is_disabled: false,
          is_not_trusted: true,
        },
      ],
    ],
    [
      queries.indexes,
      [
        {
          object_id: 100,
          index_id: 1,
          name: "IX_orders",
          is_unique: true,
          type_desc: "NONCLUSTERED",
          is_disabled: false,
          is_hypothetical: false,
          has_filter: true,
          filter_definition: "([status]<>N'deleted')",
          index_column_id: 1,
          key_ordinal: 1,
          is_descending_key: true,
          is_included_column: false,
          column_name: "id",
        },
        {
          object_id: 100,
          index_id: 1,
          name: "IX_orders",
          is_unique: true,
          type_desc: "NONCLUSTERED",
          is_disabled: false,
          is_hypothetical: false,
          has_filter: true,
          filter_definition: "([status]<>N'deleted')",
          index_column_id: 2,
          key_ordinal: 0,
          is_descending_key: false,
          is_included_column: true,
          column_name: "status",
        },
      ],
    ],
    [
      queries.routines,
      [
        {
          schema_name: "dbo",
          routine_name: "findOrder",
          object_id: 300,
          object_type: "FN",
          deterministic: true,
          is_schema_bound: true,
          null_on_null_input: true,
          uses_quoted_identifier: true,
          uses_ansi_nulls: true,
          definition_unavailable: false,
        },
      ],
    ],
    [
      queries.parameters,
      [
        {
          object_id: 300,
          parameter_id: 0,
          parameter_name: "",
          user_type_id: 127,
          system_type_id: 127,
          max_length: 8,
          precision: 19,
          scale: 0,
          is_output: true,
          is_readonly: false,
          has_default_value: false,
        },
        {
          object_id: 300,
          parameter_id: 1,
          parameter_name: "@id",
          user_type_id: 500,
          system_type_id: 127,
          max_length: 8,
          precision: 19,
          scale: 0,
          is_output: false,
          is_readonly: false,
          has_default_value: false,
        },
      ],
    ],
  ]);
  let active = false;
  const calls: string[] = [];
  const client: SqlServerQueryable = {
    async all<Row extends Record<string, unknown>>(sql: string) {
      strict.equal(active, false, "catalog requests use one native connection sequentially");
      active = true;
      calls.push(sql);
      await Promise.resolve();
      active = false;
      const rows = data.get(sql);
      if (!rows) throw new Error("unexpected query");
      return rows as readonly Row[];
    },
  };
  return { data, client, calls };
}
