import type { SourceRange } from "@typed-sql/core";

export interface ExtractedQuery {
  readonly tagName: string;
  readonly sql: string;
  readonly parameterCount: number;
  readonly insertionPosition: number;
  readonly range: SourceRange;
  readonly sqlOffsetMap: readonly number[];
  readonly interpolations: readonly ExtractedInterpolation[];
}

export interface ExtractedInterpolation {
  readonly index: number;
  readonly sourceStart: number;
  readonly expressionStart: number;
  readonly expressionEnd: number;
  readonly sourceEnd: number;
  readonly sqlStart: number;
  readonly sqlEnd: number;
}

export interface ExtractedAppendFragment {
  readonly base: ExtractedQuery;
  readonly prefix: readonly ExtractedQuery[];
  readonly fragment: ExtractedQuery;
  readonly parameterOffset: number;
}

export interface StructuralOperand {
  readonly kind: "empty" | "fragment";
  readonly start: number;
  readonly end: number;
  readonly backtick?: number;
}

export interface StructuralInterpolation {
  readonly condition?: string;
  readonly truthy: StructuralOperand;
  readonly falsy?: StructuralOperand;
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
  parameterOffset = 0,
): ExtractedQuery | undefined {
  let index = backtick + 1;
  let sql = "";
  let parameterCount = 0;
  const sqlOffsetMap: number[] = [];
  const interpolations: ExtractedInterpolation[] = [];
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
        interpolations,
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
      const sourceStart = index;
      const expressionStart = index + 2;
      const sourceEnd = interpolationEnd(source, expressionStart);
      const sqlStart = sql.length;
      const placeholder = placeholderFor(parameterOffset + parameterCount);
      sql += placeholder;
      for (let offset = 0; offset < placeholder.length; offset += 1) sqlOffsetMap.push(index);
      interpolations.push({
        index: parameterCount,
        sourceStart,
        expressionStart,
        expressionEnd: Math.max(expressionStart, sourceEnd - 1),
        sourceEnd,
        sqlStart,
        sqlEnd: sql.length,
      });
      index = sourceEnd;
      continue;
    }
    sql += char;
    sqlOffsetMap.push(index);
    index += 1;
  }
  return undefined;
}

function bindingNameBefore(source: string, start: number): string | undefined {
  let cursor = start - 1;
  while (cursor >= 0 && isWhitespace(source[cursor])) cursor -= 1;
  if (source[cursor] !== "=") return undefined;
  cursor -= 1;
  while (cursor >= 0 && isWhitespace(source[cursor])) cursor -= 1;
  const end = cursor + 1;
  while (cursor >= 0 && isIdentifierPart(source[cursor])) cursor -= 1;
  const name = source.slice(cursor + 1, end);
  return name.length > 0 && isIdentifierStart(name[0]) ? name : undefined;
}

function closingParenthesis(source: string, start: number): number | undefined {
  let depth = 1;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") index = skipQuoted(source, index, char);
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else if (char === "(") { depth += 1; index += 1; }
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    } else index += 1;
  }
  return undefined;
}

function trimmedRange(source: string, start: number, end: number): { readonly start: number; readonly end: number } {
  let first = start;
  let last = end;
  while (first < last && isWhitespace(source[first])) first += 1;
  while (last > first && isWhitespace(source[last - 1])) last -= 1;
  return { start: first, end: last };
}

function structuralOperand(source: string, start: number, end: number, tagName: string): StructuralOperand | undefined {
  const range = trimmedRange(source, start, end);
  const empty = `${tagName}.empty`;
  if (source.slice(range.start, range.end) === empty) return { kind: "empty", ...range };
  const prefix = `${tagName}.fragment`;
  if (!source.startsWith(prefix, range.start)) return undefined;
  const backtick = skipTrivia(source, range.start + prefix.length);
  if (source[backtick] !== "`" || skipQuoted(source, backtick, "`") !== range.end) return undefined;
  return { kind: "fragment", ...range, backtick };
}

export function parseStructuralInterpolation(
  source: string,
  interpolation: ExtractedInterpolation,
  tagName: string,
): StructuralInterpolation | undefined {
  const { expressionStart: start, expressionEnd: end } = interpolation;
  let question: number | undefined;
  let colon: number | undefined;
  let round = 0;
  let square = 0;
  let curly = 0;
  let index = start;
  while (index < end) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") { index = skipQuoted(source, index, char); continue; }
    if (char === "/" && source[index + 1] === "/") { index = skipLineComment(source, index); continue; }
    if (char === "/" && source[index + 1] === "*") { index = skipBlockComment(source, index); continue; }
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (round === 0 && square === 0 && curly === 0 && char === "?" && question === undefined) question = index;
    else if (round === 0 && square === 0 && curly === 0 && char === ":" && question !== undefined) { colon = index; break; }
    index += 1;
  }
  if (question === undefined || colon === undefined) {
    const truthy = structuralOperand(source, start, end, tagName);
    return truthy === undefined ? undefined : { truthy };
  }
  const truthy = structuralOperand(source, question + 1, colon, tagName);
  const falsy = structuralOperand(source, colon + 1, end, tagName);
  if (truthy === undefined || falsy === undefined) return undefined;
  const condition = trimmedRange(source, start, question);
  return {
    condition: source.slice(condition.start, condition.end),
    truthy,
    falsy,
  };
}

export function extractStructuralOperand(
  source: string,
  operand: StructuralOperand,
  tagName: string,
  placeholderFor: (index: number) => string,
  parameterOffset: number,
): ExtractedQuery | undefined {
  if (operand.kind === "empty" || operand.backtick === undefined) return undefined;
  return extractTemplate(
    source,
    `${tagName}.fragment`,
    operand.start,
    operand.backtick,
    placeholderFor,
    parameterOffset,
  );
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

export function extractAppendFragments(
  source: string,
  placeholderFor: (index: number) => string,
  sqlModules: readonly string[] = ["@typed-sql/core"],
  queries: readonly ExtractedQuery[] = extractStaticQueries(source, placeholderFor, sqlModules),
): readonly ExtractedAppendFragment[] {
  const names = importedSqlNames(source, new Set(sqlModules));
  if (names.size === 0) return [];
  const bindings = queries.flatMap((query) => {
    const name = bindingNameBefore(source, query.range.start);
    return name === undefined ? [] : [{ name, query }];
  });
  const fragments: ExtractedAppendFragment[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") { index = skipQuoted(source, index, char); continue; }
    if (char === "/" && source[index + 1] === "/") { index = skipLineComment(source, index); continue; }
    if (char === "/" && source[index + 1] === "*") { index = skipBlockComment(source, index); continue; }
    const tag = identifierAt(source, index);
    if (tag === undefined) { index += 1; continue; }
    index = tag.end;
    if (!names.has(tag.value)) continue;
    let cursor = skipTrivia(source, tag.end);
    if (source[cursor] !== ".") continue;
    cursor = skipTrivia(source, cursor + 1);
    const method = identifierAt(source, cursor);
    if (method?.value !== "append") continue;
    cursor = skipTrivia(source, method.end);
    if (source[cursor] !== "(") continue;
    const close = closingParenthesis(source, cursor);
    if (close === undefined) continue;
    let argument = skipTrivia(source, cursor + 1);
    const baseName = identifierAt(source, argument);
    if (baseName === undefined) { index = close + 1; continue; }
    const base = bindings
      .filter((binding) => binding.name === baseName.value && binding.query.range.start < index)
      .sort((left, right) => right.query.range.start - left.query.range.start)[0]?.query;
    argument = skipTrivia(source, baseName.end);
    if (base === undefined || source[argument] !== ",") { index = close + 1; continue; }

    let fragmentCursor = argument + 1;
    const prefix: ExtractedQuery[] = [];
    let parameterOffset = base.parameterCount;
    while (fragmentCursor < close) {
      const fragmentChar = source[fragmentCursor];
      if (fragmentChar === '"' || fragmentChar === "'") { fragmentCursor = skipQuoted(source, fragmentCursor, fragmentChar); continue; }
      if (fragmentChar === "`") { fragmentCursor = skipQuoted(source, fragmentCursor, fragmentChar); continue; }
      if (fragmentChar === "/" && source[fragmentCursor + 1] === "/") { fragmentCursor = skipLineComment(source, fragmentCursor); continue; }
      if (fragmentChar === "/" && source[fragmentCursor + 1] === "*") { fragmentCursor = skipBlockComment(source, fragmentCursor); continue; }
      const fragmentTag = identifierAt(source, fragmentCursor);
      if (fragmentTag === undefined) { fragmentCursor += 1; continue; }
      fragmentCursor = fragmentTag.end;
      if (fragmentTag.value !== tag.value) continue;
      let memberCursor = skipTrivia(source, fragmentTag.end);
      if (source[memberCursor] !== ".") continue;
      memberCursor = skipTrivia(source, memberCursor + 1);
      const member = identifierAt(source, memberCursor);
      if (member?.value !== "fragment") continue;
      const backtick = skipTrivia(source, member.end);
      if (source[backtick] !== "`") continue;
      const fragment = extractTemplate(
        source,
        `${tag.value}.fragment`,
        fragmentTag.end - tag.value.length,
        backtick,
        placeholderFor,
        parameterOffset,
      );
      if (fragment !== undefined) {
        fragments.push({ base, prefix: [...prefix], fragment, parameterOffset });
        prefix.push(fragment);
        parameterOffset += fragment.parameterCount;
        fragmentCursor = fragment.range.end;
      }
    }
    index = close + 1;
  }
  return fragments;
}

export function mapSqlRange(source: string, query: ExtractedQuery, range: SourceRange): SourceRange {
  const start = query.sqlOffsetMap[range.start] ?? query.range.start;
  const last = range.end > range.start ? query.sqlOffsetMap[range.end - 1] : start;
  return positionRange(source, start, (last ?? start) + 1);
}
