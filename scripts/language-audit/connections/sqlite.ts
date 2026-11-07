import { inventory } from "../inventory.mjs";
import type { AuditConnection, AuditConnectionOptions, AuditConnectionOwner } from "./contracts.js";

async function connect(_options: AuditConnectionOptions): Promise<AuditConnection> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    return db.prepare(sql).all();
  };
  const [row] = await query("SELECT sqlite_version() AS version, sqlite_source_id() AS source_id");
  const prepare = async (sql: string) => {
    try {
      const statement = db.prepare(sql);
      return {
        accepted: true,
        metadata: {
          status: "native preparation metadata for this invocation; SQLite types may be dynamic",
          columns:
            typeof statement.columns === "function"
              ? statement.columns().map((column) => ({ name: column.name, nativeType: column.type, nullable: null }))
              : null,
          parameterCount: 0,
        },
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_SQLITE_ERROR") throw error;
      return { accepted: false, reason: "ERR_SQLITE_ERROR", detail: String((error as Error).message) };
    }
  };
  const features = (await query("PRAGMA compile_options")).map((item) => String(item.compile_options));
  return {
    target: { ...row, platform: process.platform, arch: process.arch, runtime: process.version },
    query,
    prepare,
    server: {
      product: "sqlite",
      version: String(row!.version),
      versionKey: String(row!.version),
      features,
      settings: {},
    },
    close: () => db.close(),
  };
}

export const sqliteConnection: AuditConnectionOwner = {
  id: "sqlite",
  connect,
  async completeInventory(capture, connection) {
    capture.categories.extensions = inventory(
      (await connection.query("PRAGMA compile_options")).map((row) => ({ name: String(row.compile_options) })),
      "PRAGMA compile_options",
      "compile-options",
    );
  },
};
