import { postgresServerEvidence } from "../../../packages/postgres/src/capabilities.js";
import { preparePostgres } from "../native.mjs";
import type { AuditConnection, AuditConnectionOptions, AuditConnectionOwner } from "./contracts.js";

async function connect(options: AuditConnectionOptions): Promise<AuditConnection> {
  const environment = options.environment ?? process.env;
  const { Client } = await import("pg");
  if (!environment.TYPED_SQL_AUDIT_URL) throw new Error("TYPED_SQL_AUDIT_URL is required");
  const client = new Client({ connectionString: environment.TYPED_SQL_AUDIT_URL });
  await client.connect();
  const query = async (sql: string) => (await client.query(sql)).rows;
  const [row] = await query(
    "SELECT current_setting('server_version') AS version, current_setting('standard_conforming_strings') AS standard_conforming_strings, current_setting('search_path') AS search_path",
  );
  return {
    target: row,
    query,
    server: postgresServerEvidence(row.version, [], {
      standardConformingStrings: row.standard_conforming_strings,
      searchPath: row.search_path,
    }),
    prepare: (sql: string) => preparePostgres(client, sql),
    close: () => client.end(),
  };
}

export const postgresConnection: AuditConnectionOwner = { id: "postgres", connect };
