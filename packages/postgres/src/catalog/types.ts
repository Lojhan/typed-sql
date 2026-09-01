export type PostgresCatalogTypeMapping =
  | "bigint"
  | "boolean"
  | "bytes"
  | "date"
  | "json"
  | "number"
  | "numeric"
  | "string";
export type PostgresOperatorResultRule = "boolean" | "concatenation" | "json" | "json-text" | "numeric";
export type PostgresRoutineResultRule =
  | "array-aggregate"
  | "bigint-window"
  | "boolean-aggregate"
  | "coalesce"
  | "count"
  | "double-window"
  | "extrema"
  | "grouping"
  | "integer-window"
  | "json-aggregate"
  | "nullif"
  | "numeric-aggregate"
  | "ordered-set-value"
  | "string-aggregate"
  | "value-window";

export type PostgresTableRoutineResultRule =
  | "array-elements"
  | "first-argument"
  | "integer"
  | "json-array-elements"
  | "json-array-elements-text"
  | "json-each"
  | "json-each-text"
  | "record";

export interface PostgresCatalogType {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly mapping: PostgresCatalogTypeMapping;
}

export interface PostgresCatalogOperatorFamily {
  readonly name: string;
  readonly operators: readonly string[];
  readonly result: PostgresOperatorResultRule;
}

export interface PostgresCatalogRoutineFamily {
  readonly name: string;
  readonly routines: readonly string[];
  readonly result: PostgresRoutineResultRule;
}

export interface PostgresCatalogTableRoutineFamily {
  readonly name: string;
  readonly routines: readonly string[];
  readonly result: PostgresTableRoutineResultRule;
}

export interface PostgresCoreCatalog {
  readonly formatVersion: 1;
  readonly major: number;
  readonly revision: string;
  readonly types: readonly PostgresCatalogType[];
  readonly operators: readonly PostgresCatalogOperatorFamily[];
  readonly routines: readonly PostgresCatalogRoutineFamily[];
  readonly tableRoutines: readonly PostgresCatalogTableRoutineFamily[];
}
