import type { SourceRange } from "@typed-sql/core";

export interface ExtractedQuery {
  readonly tagName: string;
  readonly sql: string;
  readonly parameterCount: number;
  readonly insertionPosition: number;
  readonly range: SourceRange;
  readonly sqlOffsetMap: readonly number[];
}

function isIdentifierStart(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === "_" || char === "$";
}

function isIdentifierPart(char: string | undefined): boolean {
  if (isIdentifierStart(char)) return true;
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function identifierAt(source: string, start: number): { readonly value: string; readonly end: number } | undefined {
  if (!isIdentifierStart(source[start])) return undefined;
  let end = start + 1;
  while (isIdentifierPart(source[end])) end += 1;
  return { value: source.slice(start, end), end };
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (isWhitespace(source[index])) index += 1;
    else if (source[index] === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (source[index] === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else break;
  }
  return index;
}

function closingImportBrace(source: string, start: number): number | undefined {
  let depth = 1;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") index = skipQuoted(source, index, char);
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else if (char === "{") { depth += 1; index += 1; }
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    } else index += 1;
  }
  return undefined;
}

function importedSqlName(specifier: string): string | undefined {
  const tokens: string[] = [];
  let index = 0;
  while (index < specifier.length) {
    index = skipTrivia(specifier, index);
    const token = identifierAt(specifier, index);
    if (token === undefined) { index += 1; continue; }
    tokens.push(token.value);
    index = token.end;
  }
  if (tokens[0] !== "sql") return undefined;
  if (tokens.length === 1) return "sql";
  return tokens[1] === "as" && tokens[2] !== undefined ? tokens[2] : undefined;
}

function importedSqlNames(source: string, sqlModules: ReadonlySet<string>): ReadonlySet<string> {
  const names = new Set<string>();
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") { index = skipQuoted(source, index, char); continue; }
    if (char === "/" && source[index + 1] === "/") { index = skipLineComment(source, index); continue; }
    if (char === "/" && source[index + 1] === "*") { index = skipBlockComment(source, index); continue; }
    const keyword = identifierAt(source, index);
    if (keyword === undefined) { index += 1; continue; }
    index = keyword.end;
    if (keyword.value !== "import") continue;
    let cursor = skipTrivia(source, index);
    if (source[cursor] !== "{") continue;
    const close = closingImportBrace(source, cursor);
    if (close === undefined) break;
    const specifiers = source.slice(cursor + 1, close);
    cursor = skipTrivia(source, close + 1);
    const from = identifierAt(source, cursor);
    if (from?.value !== "from") continue;
    cursor = skipTrivia(source, from.end);
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const moduleEnd = skipQuoted(source, cursor, quote);
    if (moduleEnd > source.length || source[moduleEnd - 1] !== quote) continue;
    const moduleName = source.slice(cursor + 1, moduleEnd - 1);
    if (sqlModules.has(moduleName)) {
      for (const specifier of specifiers.split(",")) {
        const localName = importedSqlName(specifier);
        if (localName !== undefined) names.add(localName);
      }
    }
    index = moduleEnd;
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

function extractTemplate(
  source: string,
  tagName: string,
  tagStart: number,
  backtick: number,
  placeholderFor: (index: number) => string,
): ExtractedQuery | undefined {
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
      const placeholder = placeholderFor(parameterCount);
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

export function extractStaticQueries(
  source: string,
  placeholderFor: (index: number) => string,
  sqlModules: readonly string[] = ["@typed-sql/core"],
): readonly ExtractedQuery[] {
  const names = importedSqlNames(source, new Set(sqlModules));
  if (names.size === 0) return [];
  const queries: ExtractedQuery[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") { index = skipQuoted(source, index, char); continue; }
    if (char === "`" ) { index = skipQuoted(source, index, "`"); continue; }
    if (char === "/" && source[index + 1] === "/") { index = skipLineComment(source, index); continue; }
    if (char === "/" && source[index + 1] === "*") { index = skipBlockComment(source, index); continue; }
    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      const name = source.slice(start, index);
      if (!names.has(name)) continue;
      let cursor = index;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] !== "`") continue;
      const query = extractTemplate(source, name, start, cursor, placeholderFor);
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
