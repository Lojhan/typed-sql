import { parseStatement, SqlParseError, walkStatement } from "./parser/index.js";
export function postgresProjectRoutineReferences(
  sqlStatements: readonly string[],
): ReadonlyMap<string, ReadonlySet<string | undefined>> {
  if (
    sqlStatements.length > 4096 ||
    sqlStatements.reduce((size, sql) => size + Buffer.byteLength(sql), 0) > 16 * 1024 * 1024
  )
    throw new RangeError("PostgreSQL project query limit exceeded");
  const calls = new Map<string, Set<string | undefined>>();
  let references = 0;
  for (const sql of sqlStatements)
    walkStatement(parseStatement(sql), {
      expression(expression) {
        if (expression.kind !== "call") return;
        for (const identifier of [expression.name, expression.schema]) {
          if (
            identifier &&
            !identifier.quoted &&
            [...sql.slice(identifier.range.start, identifier.range.end)].some(
              (character) => character.codePointAt(0)! > 127,
            )
          )
            throw new SqlParseError("Project routine metadata requires quoted non-ASCII identifiers", identifier.range);
        }

        const name = expression.name.quoted ? expression.name.name : expression.name.name.toLowerCase();
        const namespace =
          expression.schema === undefined
            ? undefined
            : expression.schema.quoted
              ? expression.schema.name
              : expression.schema.name.toLowerCase();
        const namespaces = calls.get(name) ?? new Set<string | undefined>();
        if (!namespaces.has(namespace) && ++references > 16_384)
          throw new RangeError("PostgreSQL project routine selection limit exceeded");
        namespaces.add(namespace);
        calls.set(name, namespaces);
      },
    });

  return calls;
}
