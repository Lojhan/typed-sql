const unique = (rows) => [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
export const ordered = (rows) => unique(rows).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export const literal = (value) =>
  JSON.stringify(value, (_key, child) => (child === Infinity ? "$unbounded" : child)).replaceAll(
    '"$unbounded"',
    "Number.POSITIVE_INFINITY",
  );
export const rowsLiteral = (rows) => `[\n${rows.map((row) => `  ${literal(row)},`).join("\n")}\n]`;

export function validateParserPolicy(parser) {
  for (const name of ["keywords", "operators"]) {
    if (!Array.isArray(parser[name]) || !parser[name].length || new Set(parser[name]).size !== parser[name].length)
      throw new Error(`Parser ${name} must be nonempty and unique`);
    if (parser[name].some((value) => typeof value !== "string" || !value)) throw new Error(`Invalid parser ${name}`);
  }
  if (parser.keywords.some((name) => !/^[A-Z_][A-Z_0-9]*$/u.test(name))) throw new Error("Invalid parser keyword");
  parser.operators.forEach((operator, index) => {
    if (parser.operators.slice(index + 1).some((later) => later.startsWith(operator)))
      throw new Error(`Parser operator priority hides a longer token: ${operator}`);
  });
}

export function decodeFunctions(rows, projection = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("Missing function policy");
  const identities = new Set();
  return rows.map((row) => {
    if (!/^[A-Z_][A-Z_0-9]*$/u.test(row.name)) throw new Error(`Invalid policy function: ${row.name}`);
    const bounds = projection.bounds ? projection.bounds(row) : row.arguments;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      !Number.isSafeInteger(bounds[0]) ||
      bounds[0] < 0 ||
      !(bounds[1] === "unbounded" || (Number.isSafeInteger(bounds[1]) && bounds[1] >= bounds[0]))
    )
      throw new Error(`Invalid argument bounds: ${row.name}`);
    if (!["scalar", "aggregate", "window", "table"].includes(row.kind) || typeof (row.rule ?? row.result) !== "string")
      throw new Error(`Missing semantic policy: ${row.name}`);
    const identity = JSON.stringify([row.name, row.kind, bounds, row.availableSince ?? row.since ?? null]);
    if (identities.has(identity)) throw new Error(`Duplicate function policy: ${row.name}`);
    identities.add(identity);
    const maximum = bounds[1] === "unbounded" ? Infinity : bounds[1];
    return projection.withBounds
      ? projection.withBounds(row, [bounds[0], maximum])
      : { ...row, arguments: [bounds[0], maximum] };
  });
}

export async function parserVocabulary(policy, emit, header, id) {
  if (!policy.parser) return;
  validateParserPolicy(policy.parser);
  await emit(
    `packages/${id}/src/parser/vocabulary.generated.ts`,
    `${header}export const parserKeywords = ${rowsLiteral(policy.parser.keywords)} as const;\nexport const parserOperators = ${rowsLiteral(policy.parser.operators)} as const;\n`,
  );
}
