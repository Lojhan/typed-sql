/** Safe database metadata contains no SQL, parameters, server messages or connection information. */
export interface DatabaseErrorEvidence {
  readonly engine: "postgres";
  readonly sqlState: string;
  /** PostgreSQL's external query position: one-based Unicode characters, not bytes/UTF-16 units. */
  readonly position?: number;
}
export interface RunDatabaseDiagnostic {
  readonly origin: "database";
  readonly engine: "postgres";
  readonly code: string;
  readonly sqlState: string;
  readonly databasePosition?: number;
  readonly severity: "error";
  readonly message: string;
  readonly file: string;
  readonly sourceRevision: string;
  readonly range?: { readonly start: number; readonly end: number; readonly line: number; readonly column: number };
}
export function postgresPosition(value: unknown): number | undefined {
  const position = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  return typeof position === "number" && Number.isSafeInteger(position) && position > 0 ? position : undefined;
}
export function validateDatabaseEvidence(value: unknown): DatabaseErrorEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid database evidence");
  const evidence = value as Record<string, unknown>;
  if (
    evidence.engine !== "postgres" ||
    typeof evidence.sqlState !== "string" ||
    !/^[A-Z\d]{5}$/u.test(evidence.sqlState)
  )
    throw new TypeError("Invalid database SQLSTATE evidence");
  if (
    evidence.position !== undefined &&
    (typeof evidence.position !== "number" || postgresPosition(evidence.position) === undefined)
  )
    throw new TypeError("Invalid database position evidence");
  return {
    engine: "postgres",
    sqlState: evidence.sqlState,
    ...(evidence.position === undefined ? {} : { position: evidence.position as number }),
  };
}
export const connectionSqlState = (state: string) =>
  state.startsWith("08") || ["57P01", "57P02", "57P03"].includes(state);
export function databaseErrorEvidence(error: unknown): DatabaseErrorEvidence | undefined {
  if (
    !(error instanceof Error) ||
    error.name !== "PlaygroundPgError" ||
    !("sqlState" in error) ||
    typeof error.sqlState !== "string" ||
    !/^[A-Z\d]{5}$/u.test(error.sqlState)
  )
    return undefined;
  const position = "position" in error ? postgresPosition(error.position) : undefined;
  return {
    engine: "postgres",
    sqlState: error.sqlState,
    ...(position === undefined || connectionSqlState(error.sqlState) ? {} : { position }),
  };
}
export const databaseMessage = (state: string): string =>
  connectionSqlState(state)
    ? "PostgreSQL could not maintain the database connection."
    : state.startsWith("23")
      ? "PostgreSQL rejected data that violates a database constraint."
      : state.startsWith("22")
        ? "PostgreSQL rejected a parameter or data value."
        : state === "25006"
          ? "PostgreSQL rejected a write in read-only mode."
          : "PostgreSQL rejected the statement. Check SQL, schema and permissions.";

/** Positions are mapped only through the captured compiler-produced raw SQL source map. */
export function databaseDiagnostic(
  evidence: DatabaseErrorEvidence,
  capture: {
    file: string;
    sourceRevision: string;
    mode: string;
    source: string;
    sql?: string;
    offsets?: readonly number[];
  },
): RunDatabaseDiagnostic {
  const diagnostic: RunDatabaseDiagnostic = {
    origin: "database",
    engine: evidence.engine,
    code: `PG${evidence.sqlState}`,
    sqlState: evidence.sqlState,
    ...(evidence.position === undefined ? {} : { databasePosition: evidence.position }),
    severity: "error",
    message: databaseMessage(evidence.sqlState),
    file: capture.file,
    sourceRevision: capture.sourceRevision,
  };
  if (
    capture.mode !== "sql" ||
    !capture.file.endsWith(".sql") ||
    evidence.position === undefined ||
    connectionSqlState(evidence.sqlState) ||
    capture.sql === undefined ||
    capture.offsets === undefined
  )
    return diagnostic;
  const { sql, source, offsets } = capture;
  if (
    offsets.length !== sql.length ||
    !offsets.every(
      (offset, index) =>
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset < source.length &&
        (index === 0 || offset >= offsets[index - 1]!),
    )
  )
    return diagnostic;
  let normalized = 0,
    character = 1;
  for (const point of sql) {
    if (character === evidence.position) break;
    normalized += point.length;
    character++;
  }
  if (character !== evidence.position) return diagnostic;
  const start =
    normalized === sql.length
      ? (offsets.length === 0 && source.length === 0) || offsets.at(-1) === source.length - 1
        ? source.length
        : undefined
      : offsets[normalized];
  if (start === undefined) return diagnostic;
  // Do not underline half of a surrogate pair. EOF is an exact, zero-width point.
  if (
    start > 0 &&
    start < source.length &&
    source.charCodeAt(start) >= 0xdc00 &&
    source.charCodeAt(start) <= 0xdfff &&
    source.charCodeAt(start - 1) >= 0xd800 &&
    source.charCodeAt(start - 1) <= 0xdbff
  )
    return diagnostic;
  const end = Math.min(source.length, start + (source.codePointAt(start)! > 0xffff ? 2 : 1));
  const prefix = source.slice(0, start),
    line = prefix.split("\n").length,
    column = start - (prefix.lastIndexOf("\n") + 1) + 1;
  return { ...diagnostic, range: { start, end, line, column } };
}
