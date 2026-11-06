import type { SqlServerServicePool, SqlServerServiceSession } from "../../src/live-verifier.js";
import { sqlServerVerificationQueries } from "../../src/live-verifier.js";
import { sqlServerPlanQueries } from "../../src/plan-inspector.js";
import { sqlServerCatalogQueries } from "../../src/provider.js";
export const fingerprint = `sha256:${"a".repeat(64)}`;
export const showplan = `<?xml version="1.0"?><ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementType="SELECT" StatementText="SELECT private_literal FROM private_connection" StatementSubTreeCost="0.02"><QueryPlan><ParameterList><ColumnReference ParameterCompiledValue="recognizable-secret"/></ParameterList><RelOp PhysicalOp="Index Seek" EstimateRows="1.5" EstimatedTotalSubtreeCost="0.02"><IndexScan><Object Database="[private_database]" Schema="[dbo]" Table="[widgets]" Index="[IX_widgets]"/><ScalarOperator ScalarString="recognizable-secret"/></IndexScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
export class ServiceHarness implements SqlServerServicePool {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  acquired = 0;
  released = 0;
  discarded = 0;
  closed = 0;
  showplan = false;
  fail: string | undefined;
  xml = showplan;
  version = "17.0.5035.5";
  scale = 2;
  statisticsRows = "10";
  parameters: readonly Record<string, unknown>[] = [
    { name: "@__typed_sql_1", suggested_system_type_name: "bigint", suggested_is_input: 1, suggested_is_output: 0 },
  ];
  columns: readonly Record<string, unknown>[] | undefined;
  async acquire(): Promise<SqlServerServiceSession> {
    this.acquired++;
    return {
      all: <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) =>
        this.query(sql, values) as Promise<readonly Row[]>,
      release: () => {
        this.released++;
      },
      discard: () => {
        this.discarded++;
      },
    };
  }
  async close() {
    this.closed++;
  }
  async query(sql: string, values: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    this.calls.push({ sql, values });
    if (sql === this.fail) throw new Error("SELECT recognizable-secret FROM private_connection");
    if (sql === sqlServerCatalogQueries.server)
      return [
        {
          version: this.version,
          edition: "Developer Edition",
          engine_edition: 3,
          database_name: "private_database",
          default_schema: "dbo",
          compatibility_level: 170,
          collation_name: "Latin1_General_100_CI_AS",
          quoted_identifier: 1,
          ansi_warnings: 1,
          arith_abort: 1,
          concat_null_on: 1,
          date_first: 7,
          language: "us_english",
          can_view_definition: 1,
        },
      ];
    if (sql === sqlServerCatalogQueries.options) return [{ SetOption: "dateformat", Value: "mdy" }];
    if (sql === sqlServerVerificationQueries.parameters) return this.parameters;
    if (sql === sqlServerVerificationQueries.columns)
      return (
        this.columns ?? [
          {
            is_hidden: 0,
            column_ordinal: 1,
            name: "amount",
            system_type_name: `decimal(12,${this.scale})`,
            is_nullable: 0,
            collation_name: null,
            error_number: null,
            error_type: null,
          },
        ]
      );
    if (sql === sqlServerPlanQueries.settings)
      return [
        { name: "MAXDOP", value: "0" },
        { name: "PARAMETER_SNIFFING", value: "1" },
      ];
    if (sql === sqlServerPlanQueries.session) return [{ options: "5496" }];
    if (sql === sqlServerPlanQueries.statistics)
      return [
        {
          object_id: 1,
          stats_id: 1,
          last_updated: "2026-11-05T00:00:00",
          rows: this.statisticsRows,
          rows_sampled: "10",
          modification_counter: "0",
        },
      ];
    if (sql === sqlServerPlanQueries.on) {
      this.showplan = true;
      return [];
    }
    if (sql === sqlServerPlanQueries.off) {
      this.showplan = false;
      return [];
    }
    if (!this.showplan) throw new Error("User SQL executed outside SHOWPLAN");
    return [{ ShowplanXML: this.xml }];
  }
}
