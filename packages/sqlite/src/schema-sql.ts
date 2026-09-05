interface Span {
  readonly start: number;
  readonly end: number;
}

function quotedEnd(source: string, start: number): number {
  const quote = source[start]!;
  const close = quote === "[" ? "]" : quote;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] !== close) continue;
    if (source[index + 1] === close) index += 1;
    else return index + 1;
  }
  return source.length;
}

function parenthesized(source: string, open: number): Span | undefined {
  if (source[open] !== "(") return undefined;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      index = quotedEnd(source, index) - 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return { start: open + 1, end: index };
  }
  return undefined;
}

function topLevelParts(source: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      index = quotedEnd(source, index) - 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function identifier(source: string): { readonly name: string; readonly end: number } | undefined {
  const start = source.search(/\S/u);
  if (start < 0) return undefined;
  const quote = source[start]!;
  if (quote === '"' || quote === "`" || quote === "[") {
    const end = quotedEnd(source, start);
    const close = quote === "[" ? "]" : quote;
    return {
      name: source.slice(start + 1, Math.max(start + 1, end - 1)).replaceAll(close + close, close),
      end,
    };
  }
  const match = /^[^\s(),]+/u.exec(source.slice(start));
  return match === null ? undefined : { name: match[0], end: start + match[0].length };
}

function tableBody(definition: string): string | undefined {
  const open = definition.indexOf("(");
  const span = open < 0 ? undefined : parenthesized(definition, open);
  return span === undefined ? undefined : definition.slice(span.start, span.end);
}

function sqliteColumnDefinition(definition: string | undefined, column: string): string | undefined {
  if (definition === undefined) return undefined;
  const body = tableBody(definition);
  if (body === undefined) return undefined;
  for (const part of topLevelParts(body)) {
    const first = identifier(part);
    if (first?.name.toLowerCase() === column.toLowerCase()) return part;
  }
  return undefined;
}

export function sqliteColumnCollation(definition: string | undefined, column: string): string | undefined {
  const columnSql = sqliteColumnDefinition(definition, column);
  if (columnSql === undefined) return undefined;
  const match = /\bCOLLATE\s+((?:"(?:""|[^"])+")|(?:`(?:``|[^`])+`)|(?:\[(?:\]\]|[^\]])+\])|[^\s,)]+)/iu.exec(
    columnSql,
  );
  if (match === null) return undefined;
  return identifier(match[1]!)?.name;
}

export function sqliteGeneratedExpression(definition: string | undefined, column: string): string | undefined {
  const columnSql = sqliteColumnDefinition(definition, column);
  if (columnSql === undefined || !/\b(?:GENERATED\s+ALWAYS\s+)?AS\s*\(/iu.test(columnSql)) return undefined;
  const match = /\b(?:GENERATED\s+ALWAYS\s+)?AS\s*\(/giu.exec(columnSql);
  if (match === null) return undefined;
  const open = match.index + match[0].lastIndexOf("(");
  const span = parenthesized(columnSql, open);
  return span === undefined ? undefined : columnSql.slice(span.start, span.end).trim();
}

export function sqliteCheckExpressions(definition: string | undefined): readonly string[] {
  if (definition === undefined) return [];
  const expressions: string[] = [];
  const check = /\bCHECK\s*\(/giu;
  for (let match = check.exec(definition); match !== null; match = check.exec(definition)) {
    const open = match.index + match[0].lastIndexOf("(");
    const span = parenthesized(definition, open);
    if (span === undefined) continue;
    expressions.push(definition.slice(span.start, span.end).trim());
    check.lastIndex = span.end + 1;
  }
  return expressions;
}

function indexParts(definition: string | undefined): {
  readonly terms: readonly string[];
  readonly predicate?: string;
} {
  if (definition === undefined) return { terms: [] };
  const on = /\bON\b/giu.exec(definition);
  if (on === null) return { terms: [] };
  const open = definition.indexOf("(", on.index + on[0].length);
  const span = open < 0 ? undefined : parenthesized(definition, open);
  if (span === undefined) return { terms: [] };
  const tail = definition.slice(span.end + 1);
  const where = /\bWHERE\b/iu.exec(tail);
  return {
    terms: topLevelParts(definition.slice(span.start, span.end)),
    ...(where === null ? {} : { predicate: tail.slice(where.index + where[0].length).trim() }),
  };
}

export function sqliteIndexExpression(definition: string | undefined, position: number): string | undefined {
  const term = indexParts(definition).terms[position];
  if (term === undefined) return undefined;
  return term
    .replace(/\s+(?:ASC|DESC)\s*$/iu, "")
    .replace(/\s+COLLATE\s+(?:"(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:\]\]|[^\]])+\]|[^\s,)]+)\s*$/iu, "")
    .trim();
}

export function sqliteIndexPredicate(definition: string | undefined): string | undefined {
  return indexParts(definition).predicate;
}

export function sqliteVirtualTableModule(definition: string | undefined): string | undefined {
  if (definition === undefined) return undefined;
  const match = /\bUSING\s+((?:"(?:""|[^"])+")|(?:`(?:``|[^`])+`)|(?:\[(?:\]\]|[^\]])+\])|[^\s(]+)/iu.exec(definition);
  return match === null ? undefined : identifier(match[1]!)?.name;
}
