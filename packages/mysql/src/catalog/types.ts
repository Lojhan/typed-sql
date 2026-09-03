export type MySqlCatalogTypeMapping =
  | "bigint"
  | "boolean"
  | "bytes"
  | "date"
  | "json"
  | "number"
  | "numeric"
  | "string"
  | "unknown";

export type MySqlTypeCategory =
  | "binary"
  | "boolean"
  | "collection"
  | "json"
  | "numeric-approximate"
  | "numeric-decimal"
  | "numeric-integer"
  | "spatial"
  | "string"
  | "temporal"
  | "vector";

export type MySqlCoercionContext = "arithmetic" | "assignment" | "comparison" | "explicit" | "string";
export type MySqlCoercionSafety = "lossless" | "warning" | "lossy";
export type MySqlOperatorResultRule = "bitwise" | "boolean" | "json" | "json-text" | "numeric";
export type MySqlRoutineResultRule =
  | "bigint"
  | "bytes"
  | "coalesce"
  | "coercibility"
  | "collation-name"
  | "concat"
  | "count"
  | "date"
  | "decimal-aggregate"
  | "double"
  | "extrema"
  | "first-argument"
  | "integer"
  | "json"
  | "string"
  | "vector"
  | "value-window";

export interface MySqlCatalogType {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly mapping: MySqlCatalogTypeMapping;
  readonly category: MySqlTypeCategory;
  readonly signedness: "signed" | "unsigned" | "both" | "none";
}

export interface MySqlCatalogCoercion {
  readonly source: string;
  readonly target: string;
  readonly contexts: readonly MySqlCoercionContext[];
  readonly safety: MySqlCoercionSafety;
}

export interface MySqlCatalogOperatorFamily {
  readonly name: string;
  readonly operators: readonly string[];
  readonly result: MySqlOperatorResultRule;
}

export interface MySqlCatalogRoutineFamily {
  readonly name: string;
  readonly routines: readonly string[];
  readonly result: MySqlRoutineResultRule;
  readonly minimumArguments: number;
  readonly maximumArguments: number | null;
  readonly nullability: "arguments" | "never" | "always";
  readonly editions: readonly ("commercial" | "community" | "enterprise" | "source")[];
}

export interface MySqlCatalogCollation {
  readonly name: string;
  readonly characterSet: string;
  readonly unicode: boolean;
  readonly binary: boolean;
}

export interface MySqlCoreCatalog {
  readonly formatVersion: 1;
  readonly series: "8.4" | "9.7" | "26.7";
  readonly revision: string;
  readonly types: readonly MySqlCatalogType[];
  readonly coercions: readonly MySqlCatalogCoercion[];
  readonly operators: readonly MySqlCatalogOperatorFamily[];
  readonly routines: readonly MySqlCatalogRoutineFamily[];
  readonly collations: readonly MySqlCatalogCollation[];
}
