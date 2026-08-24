import type { SourceRange } from "@typed-sql/ast";

export interface ExtractedQuery {
  readonly tagName: string;
  readonly sql: string;
  readonly parameterCount: number;
  readonly insertionPosition: number;
  readonly range: SourceRange;
  readonly sqlOffsetMap: readonly number[];
}

const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;

function importedSqlNames(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(importPattern)) {
    const specifiers = match[1];
    const moduleName = match[2];
    if (specifiers === undefined || moduleName === undefined) continue;
    if (!moduleName.includes("generated") && moduleName !== "@typed-sql/runtime") continue;
    for (const specifier of specifiers.split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0] === "sql") names.add(parts[1] ?? "sql");
    }
  }
  return names;
}

function positionRange(source: string, start: number, end: number): SourceRange {
  const before = source.slice(0, start);
  const lastNewline = before.lastIndexOf("\n");
  return {
    start,
    end,
    line: before.split("\n").length,
    column: start - lastNewline,
  };
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return source.length;
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start + 2);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
}

function interpolationEnd(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") index = skipQuoted(source, index, char);
    else if (char === "`" ) index = skipQuoted(source, index, "`");
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else if (char === "{") { depth += 1; index += 1; }
    else if (char === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
    } else index += 1;
  }
  return source.length;
}

function extractTemplate(source: string, tagName: string, tagStart: number, backtick: number): ExtractedQuery | undefined {
  let index = backtick + 1;
  let sql = "";
  let parameterCount = 0;
  const sqlOffsetMap: number[] = [];
  while (index < source.length) {
    const char = source[index]!;
    if (char === "`" ) {
      return {
        tagName,
        sql,
        parameterCount,
        insertionPosition: tagStart + tagName.length,
        range: positionRange(source, tagStart, index + 1),
        sqlOffsetMap,
      };
    }
    if (char === "\\" && index + 1 < source.length) {
      sql += source[index + 1]!;
      sqlOffsetMap.push(index);
      index += 2;
      continue;
    }
    if (char === "$" && source[index + 1] === "{") {
      parameterCount += 1;
      const placeholder = `$${parameterCount}`;
      sql += placeholder;
      for (let offset = 0; offset < placeholder.length; offset += 1) sqlOffsetMap.push(index);
      index = interpolationEnd(source, index + 2);
      continue;
    }
    sql += char;
    sqlOffsetMap.push(index);
    index += 1;
  }
  return undefined;
}

export function extractStaticQueries(source: string): readonly ExtractedQuery[] {
  const names = importedSqlNames(source);
  if (names.size === 0) return [];
  const queries: ExtractedQuery[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") { index = skipQuoted(source, index, char); continue; }
    if (char === "`" ) { index = skipQuoted(source, index, "`"); continue; }
    if (char === "/" && source[index + 1] === "/") { index = skipLineComment(source, index); continue; }
    if (char === "/" && source[index + 1] === "*") { index = skipBlockComment(source, index); continue; }
    if (char !== undefined && /[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      const name = source.slice(start, index);
      if (!names.has(name)) continue;
      let cursor = index;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] !== "`") continue;
      const query = extractTemplate(source, name, start, cursor);
      if (query !== undefined) {
        queries.push(query);
        index = query.range.end;
      }
      continue;
    }
    index += 1;
  }
  return queries;
}

export function mapSqlRange(source: string, query: ExtractedQuery, range: SourceRange): SourceRange {
  const start = query.sqlOffsetMap[range.start] ?? query.range.start;
  const last = range.end > range.start ? query.sqlOffsetMap[range.end - 1] : start;
  return positionRange(source, start, (last ?? start) + 1);
}
