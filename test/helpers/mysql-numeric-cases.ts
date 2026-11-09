/** Targeted native regression witnesses, shared by static and real-engine verification. */
export const mysqlNumericCases = [
  { expression: "ABS(CAST(-2 AS SIGNED))", type: "bigint", databaseType: "bigint", nullable: false, value: 2n },
  {
    expression: "ABS(CAST('-9007199254740993' AS SIGNED))",
    type: "bigint",
    databaseType: "bigint",
    nullable: false,
    value: 9007199254740993n,
  },
  {
    expression: "ABS(CAST(-2.25 AS DECIMAL(9,2)))",
    type: "string",
    databaseType: "decimal(9,2)",
    nullable: false,
    value: "2.25",
  },
  { expression: "ACOS(2)", type: "number", databaseType: "double", nullable: true, value: null },
  { expression: "LOG(-1)", type: "number", databaseType: "double", nullable: true, value: null },
  { expression: "SQRT(-1)", type: "number", databaseType: "double", nullable: true, value: null },
  {
    expression: "FLOOR(CAST(1.25 AS DECIMAL(9,2)))",
    type: "bigint",
    databaseType: "bigint",
    nullable: false,
    value: 1n,
  },
  {
    expression: "ROUND(CAST(1.25 AS DECIMAL(9,2)),1)",
    type: "string",
    databaseType: "decimal(9,1)",
    nullable: false,
    value: "1.3",
  },
  { expression: "SIN(0)", type: "number", databaseType: "double", nullable: true, value: 0 },
] as const;
