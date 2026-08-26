export const diagnosticRegistry = Object.freeze({
  TSQ001: { category: "syntax", summary: "SQL syntax could not be parsed." },
  TSQ002: { category: "resource", summary: "SQL exceeded a parser resource limit." },
  TSQ003: { category: "resource", summary: "Conditional SQL exceeded the structural variant limit." },
  TSQ004: { category: "contract", summary: "Structural SQL requires an explicitly trusted fragment." },
  TSQ007: { category: "contract", summary: "The schema snapshot and dialect do not match." },
  TSQ100: { category: "schema", summary: "A referenced table does not exist." },
  TSQ101: { category: "schema", summary: "A referenced column does not exist." },
  TSQ102: { category: "schema", summary: "A column reference is ambiguous." },
  TSQ103: { category: "schema", summary: "A relation alias or qualified column is unknown." },
  TSQ104: { category: "result", summary: "A result expression needs an explicit output name." },
  TSQ105: { category: "result", summary: "Two result columns produce the same property name." },
  TSQ106: { category: "type", summary: "A cast target is invalid or unknown." },
  TSQ107: { category: "schema", summary: "An unqualified table name is ambiguous." },
  TSQ108: { category: "schema", summary: "A relation alias is duplicated." },
  TSQ202: { category: "type", summary: "A function is unknown." },
  TSQ203: { category: "type", summary: "An operator cannot be inferred safely." },
  TSQ204: { category: "type", summary: "A function overload is ambiguous." },
  TSQ205: { category: "type", summary: "A composed parameter has incompatible structural contexts." },
  TSQ210: { category: "support", summary: "Recursive CTE inference is not supported safely." },
  TSQ211: { category: "schema", summary: "A CTE name is duplicated." },
  TSQ212: { category: "result", summary: "A CTE does not return rows." },
  TSQ213: { category: "result", summary: "A CTE column list has the wrong arity." },
  TSQ214: { category: "result", summary: "INSERT source and target arities differ." },
  TSQ215: { category: "schema", summary: "A JOIN USING column is not unique on both sides." },
  TSQ216: { category: "result", summary: "A scalar subquery does not return exactly one column." },
  TSQ217: { category: "result", summary: "An IN subquery does not return exactly one column." },
  TSQ301: { category: "drift", summary: "The live schema or type policy differs from the generated snapshot." },
  TSQ401: { category: "support", summary: "The dialect surface is intentionally unsupported." },
} as const);

export type TypedSqlDiagnosticCode = keyof typeof diagnosticRegistry;

export function isTypedSqlDiagnosticCode(value: string): value is TypedSqlDiagnosticCode {
  return Object.hasOwn(diagnosticRegistry, value);
}
