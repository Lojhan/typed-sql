import { constants, DatabaseSync } from "node:sqlite";
import { queryContractDigest } from "@typed-sql/analysis";
import { tokenize } from "./parser/tokenizer.js";
import { sqliteVersionSupport } from "./support.js";

// Only this explicit worker imports the native driver. Candidate statements are never stepped.
let database: DatabaseSync | undefined;
let nativeScope: string;
let ordinary: Set<string>;
let functions: Set<string>;
let described = false;
const denied = () => constants.SQLITE_DENY;
const fold = (value: string) => value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
function initialize() {
  database = new DatabaseSync(process.argv[2]!, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 100,
  });
  if (typeof database.setAuthorizer !== "function") throw Error("unsupported-context");
  database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN");
  const schema = database.prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name").all();
  // Reject virtual-table schemas before candidate compilation can invoke a module's xConnect.
  if (
    schema.some(
      (row) =>
        row.type === "table" &&
        typeof row.sql === "string" &&
        tokenize(row.sql)
          .slice(0, 3)
          .map(({ text }) => text.toUpperCase())
          .join(" ") === "CREATE VIRTUAL TABLE",
    )
  )
    throw Error("unsupported-context");
  ordinary = new Set(
    schema.filter((row) => row.type === "table" || row.type === "view").map((row) => fold(String(row.name))),
  );
  ordinary.add("sqlite_schema");
  ordinary.add("sqlite_master");
  const inventory = database.prepare("PRAGMA function_list").all();
  functions = new Set(inventory.filter((row) => row.builtin === 1).map((row) => fold(String(row.name))));
  functions.delete("load_extension");
  const versionStatement = database.prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS source");
  const version = versionStatement.get();
  if ("close" in versionStatement && typeof versionStatement.close === "function") versionStatement.close();
  if (typeof version?.version !== "string" || sqliteVersionSupport(version.version) !== "supported")
    throw Error("unsupported-context");
  const compileOptions = database.prepare("PRAGMA compile_options").all();
  const collations = database.prepare("PRAGMA collation_list").all();
  const schemaVersion = database.prepare("PRAGMA main.schema_version").get();
  nativeScope = queryContractDigest({
    schema,
    version,
    compileOptions,
    inventory,
    collations,
    schemaVersion,
    transport: "owned-node-sqlite-readonly-snapshot-v1",
  });
  database.setAuthorizer((action, first, second, namespace) => {
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
    if (action === constants.SQLITE_READ && namespace === "main" && first && ordinary.has(fold(first)))
      return constants.SQLITE_OK;
    if (action === constants.SQLITE_FUNCTION && second && functions.has(fold(second))) return constants.SQLITE_OK;
    return denied();
  });
  process.send!({ kind: "ready", scope: nativeScope, version: version.version });
}
try {
  initialize();
} catch (error) {
  try {
    database?.close();
  } catch {
    /* The parent also terminates this owned worker. */
  }
  process.send!({
    kind: "error",
    reason:
      error instanceof Error && error.message === "unsupported-context" ? "unsupported-context" : "native-failure",
  });
}
process.on("message", (message: { kind: string; sql?: string }) => {
  try {
    if (!database) throw Error("closed-session");
    if (message.kind === "describe") {
      if (described) {
        process.send!({ kind: "error", reason: "unsupported-context" });
        return;
      }
      described = true;
      const statement = database.prepare(message.sql!);
      try {
        const columns = statement.columns();
        if (!columns.length) throw Error("unsupported-statement");
        process.send!({ kind: "described", columns });
      } finally {
        if ("close" in statement && typeof statement.close === "function") statement.close();
      }
    } else if (message.kind === "close") {
      database.close();
      process.disconnect();
    } else throw Error("unsupported-statement");
  } catch {
    // Driver diagnostics can contain source SQL, paths or data. Only sanitized failures cross.
    process.send!({ kind: "error", reason: "native-rejected" });
  }
});
