import { randomBytes } from "node:crypto";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { strict } from "poku";
import { acquireNativeQueryContract } from "../../packages/analysis/src/index.js";
import { createMySql2NativeContractAdapter } from "../../packages/mysql/src/mysql2-contracts.js";

/** Real mutations in the disposable native fixture; owned connections never execute candidates. */
export async function assertMySqlContextMutations(
  connectionUri: string,
  schema: Parameters<typeof createMySql2NativeContractAdapter>[0]["schema"],
  table: string,
): Promise<void> {
  strict.match(table, /^typed_sql_native_\d+_calls$/u);
  const admin = await createConnection(connectionUri);
  const quote = (name: string) => `\`${name.replaceAll("`", "``")}\``;
  const role = `${quote(`typed_ctx_${process.pid}_r\`q`)}@'%'`;
  const userName = `typed_ctx_${process.pid}_principal`;
  const user = `${quote(userName)}@'%'`;
  const candidate = { sql: "SELECT 1 AS value", parameterOccurrences: [] };
  let granted = false;
  let principal = "";
  const adapter = (setup?: string, uri = connectionUri) =>
    createMySql2NativeContractAdapter({
      connectionUri: uri,
      schema,
      ...(setup
        ? {
            async driverImporter() {
              const driver = await import("mysql2/promise");
              return {
                ...driver,
                async createConnection(options: string | Parameters<typeof driver.createConnection>[0]) {
                  const connection =
                    typeof options === "string"
                      ? await driver.createConnection(options)
                      : await driver.createConnection(options);
                  try {
                    await connection.query(setup);
                    return connection;
                  } catch (error) {
                    connection.destroy();
                    throw error;
                  }
                },
              };
            },
          }
        : {}),
    });
  const stale = async (
    selected: ReturnType<typeof adapter>,
    before: Awaited<ReturnType<ReturnType<typeof adapter>["inspectContext"]>>,
    name: string,
  ) => {
    const after = await selected.inspectContext();
    strict.notEqual(after.databaseContextHash, before.databaseContextHash, `${name} changes native context`);
    strict.equal(after.schemaHash, before.schemaHash, `${name} keeps the compiler schema fixed`);
    strict.deepEqual(
      await acquireNativeQueryContract({ adapter: selected, context: before, candidate }),
      { status: "unavailable", reason: "context-mismatch" },
      `${name} rejects prior context`,
    );
  };
  try {
    const [[account]] = await admin.query<RowDataPacket[]>("SELECT CURRENT_USER() AS principal,DATABASE() AS db");
    const parts = /^([^@]+)@([^@]+)$/u.exec(String(account?.principal));
    if (!parts) throw new Error("The owned fixture requires an unambiguous account name");
    principal = `${quote(parts[1]!)}@${quote(parts[2]!)}`;
    const base = adapter();
    const before = await base.inspectContext();
    await admin.query(`GRANT SELECT ON ${quote(table)} TO ${principal}`);
    granted = true;
    await stale(base, before, "Direct permission grant");
    await admin.query(`REVOKE SELECT ON ${quote(table)} FROM ${principal}`);
    granted = false;

    await admin.query(`CREATE ROLE ${role}`);
    await admin.query(`GRANT ${role} TO ${principal}`);
    const inactive = adapter("SET ROLE NONE");
    const active = adapter(`SET ROLE ${role}`);
    await stale(active, await inactive.inspectContext(), "Enabled role");
    const roleBefore = await active.inspectContext();
    await admin.query(`GRANT SELECT ON ${quote(table)} TO ${role}`);
    await stale(active, roleBefore, "Effective role permission grant");

    const utc = adapter("SET SESSION time_zone='+00:00'");
    await stale(adapter("SET SESSION time_zone='+01:00'"), await utc.inspectContext(), "Semantic time-zone setting");
    if (schema.formatVersion !== 2) throw new Error("The native fixture requires versioned SQL-mode evidence");
    const mode = String(schema.server.settings.sqlMode).split(",").includes("ANSI_QUOTES")
      ? "NO_ENGINE_SUBSTITUTION"
      : "ANSI_QUOTES";
    await strict.rejects(
      adapter(`SET SESSION sql_mode='${mode}'`).inspectContext(),
      /unsupported-context/u,
      "A changed SQL mode cannot qualify the old compiler environment",
    );
    await stale(adapter("USE mysql"), await base.inspectContext(), "Selected database");

    const password = randomBytes(16).toString("hex");
    await admin.query(`CREATE USER ${user} IDENTIFIED BY ?`, [password]);
    await admin.query(`GRANT BACKUP_ADMIN,SHOW_ROUTINE ON *.* TO ${user}`);
    await admin.query(`GRANT SELECT ON performance_schema.* TO ${user}`);
    await admin.query(`GRANT SELECT ON ${quote(String(account?.db))}.* TO ${user}`);
    const uri = new URL(connectionUri);
    uri.username = userName;
    uri.password = password;
    await stale(adapter(undefined, uri.toString()), await base.inspectContext(), "Authorization principal");
  } finally {
    try {
      if (granted) await admin.query(`REVOKE SELECT ON ${quote(table)} FROM ${principal}`);
      await admin.query(`DROP USER IF EXISTS ${user}`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await admin.end();
    }
  }
}
