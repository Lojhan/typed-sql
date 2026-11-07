import { mySqlServerEvidence } from "../../../packages/mysql/src/capabilities.js";
import { prepareMySql } from "../native.mjs";
import type { AuditConnection, AuditConnectionOptions, AuditConnectionOwner } from "./contracts.js";

async function connect(options: AuditConnectionOptions): Promise<AuditConnection> {
  const environment = options.environment ?? process.env;
  const { createConnection } = await import("mysql2/promise");
  if (!environment.TYPED_SQL_AUDIT_URL) throw new Error("TYPED_SQL_AUDIT_URL is required");
  const client = await createConnection(environment.TYPED_SQL_AUDIT_URL);
  const query = async (sql: string) => (await client.query(sql))[0] as Record<string, unknown>[];
  const [row] = await query("SELECT VERSION() AS version, @@version_comment AS edition, @@sql_mode AS sql_mode");
  if (!row) {
    await client.end();
    throw new Error("MySQL version query returned no row");
  }
  return {
    target: row,
    query,
    server: mySqlServerEvidence(String(row!.version), {
      versionComment: String(row!.edition),
      sqlMode: String(row!.sql_mode),
    }),
    prepare: (sql: string) => prepareMySql(client, sql),
    close: () => client.end(),
  };
}

export const mysqlConnection: AuditConnectionOwner = { id: "mysql", connect };
