import type { FunctionSnapshot } from "@typed-sql/schema";
import type { SqliteTypePolicy } from "./type-policy.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface SqliteQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): MaybePromise<readonly Row[]>;
}

export interface SqliteSchemaProviderOptions {
  readonly client: SqliteQueryable;
  readonly schemas?: readonly string[];
  /** @deprecated Use routines to preserve scalar, aggregate, and window kind evidence. */
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
  readonly routines?: Readonly<Record<string, SqliteRoutineDeclaration>>;
  readonly typePolicy?: SqliteTypePolicy;
}

export interface SqliteRoutineArgumentDeclaration {
  readonly databaseType: string;
  readonly tsType?: string;
}

export interface SqliteRoutineResultDeclaration {
  readonly databaseType: string;
  readonly tsType?: string;
  readonly nullable: boolean;
}

/** Explicit application registry for routines installed on an SQLite connection. */
export interface SqliteRoutineDeclaration {
  readonly name: string;
  readonly schema?: string;
  readonly kind: "aggregate" | "scalar" | "window";
  readonly arguments: readonly SqliteRoutineArgumentDeclaration[];
  readonly result: SqliteRoutineResultDeclaration;
  readonly deterministic?: boolean;
  readonly volatility?: "immutable" | "stable" | "volatile";
  readonly nullInput?: "called" | "strict";
}
