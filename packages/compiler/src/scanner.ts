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

export interface ExtractedDynamicQuery {
  readonly tagName: string;
  readonly range: SourceRange;
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

export interface UntaggedStructuralTemplate {
  readonly tagName: string;
  readonly range: SourceRange;
}

export type RepeatedFragmentDiscovery =
  | { readonly kind: "none" }
  | {
      readonly kind: "error";
      readonly code: "TSQ008" | "TSQ009" | "TSQ010" | "TSQ011" | "TSQ012" | "TSQ013" | "TSQ014";
      readonly message: string;
      readonly suggestion: string;
      readonly range: SourceRange;
    }
  | {
      readonly kind: "fragments";
      readonly dynamic: boolean;
      readonly representativeItems: 1 | 2;
      readonly elements: readonly StructuralOperand[];
      readonly range: SourceRange;
    };

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
    else if (char === "{") {
      depth += 1;
      index += 1;
    } else if (char === "}") {
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
    if (token === undefined) {
      index += 1;
      continue;
    }
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
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    const keyword = identifierAt(source, index);
    if (keyword === undefined) {
      index += 1;
      continue;
    }
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

const MAX_LINE_START_CACHE_ENTRIES = 8;
const lineStartCache = new Map<string, readonly number[]>();

function lineStarts(source: string): readonly number[] {
  const cached = lineStartCache.get(source);
  if (cached !== undefined) {
    lineStartCache.delete(source);
    lineStartCache.set(source, cached);
    return cached;
  }
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  lineStartCache.set(source, starts);
  while (lineStartCache.size > MAX_LINE_START_CACHE_ENTRIES) {
    lineStartCache.delete(lineStartCache.keys().next().value!);
  }
  return starts;
}

function positionRange(source: string, start: number, end: number): SourceRange {
  const starts = lineStarts(source);
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((starts[middle] ?? 0) <= start) low = middle + 1;
    else high = middle;
  }
  const lineIndex = Math.max(0, low - 1);
  const lineStart = starts[lineIndex] ?? 0;
  return {
    start,
    end,
    line: lineIndex + 1,
    column: start - lineStart + 1,
  };
}

function skipQuoted(source: string, start: number, quote: string): number {
  if (quote === "`") return skipTemplate(source, start);
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === "`") return index + 1;
    else if (source[index] === "$" && source[index + 1] === "{") index = interpolationEnd(source, index + 2);
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
    else if (char === "`") index = skipQuoted(source, index, "`");
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else if (char === "{") {
      depth += 1;
      index += 1;
    } else if (char === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
    } else index += 1;
  }
  return source.length;
}

function hexadecimalValue(source: string, start: number, length: number): number | undefined {
  const value = source.slice(start, start + length);
  return value.length === length && /^[\dA-Fa-f]+$/u.test(value) ? Number.parseInt(value, 16) : undefined;
}

function cookedEscape(source: string, start: number): { readonly text: string; readonly end: number } | undefined {
  const escaped = source[start + 1];
  if (escaped === undefined) return undefined;
  const simple: Readonly<Record<string, string>> = {
    "0": "\0",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  if (escaped === "\n") return { text: "", end: start + 2 };
  if (escaped === "\r") {
    return { text: "", end: source[start + 2] === "\n" ? start + 3 : start + 2 };
  }
  if (escaped === "0" && /\d/u.test(source[start + 2] ?? "")) return undefined;
  if (escaped in simple) return { text: simple[escaped]!, end: start + 2 };
  if (escaped === "x") {
    const value = hexadecimalValue(source, start + 2, 2);
    return value === undefined ? undefined : { text: String.fromCodePoint(value), end: start + 4 };
  }
  if (escaped === "u") {
    if (source[start + 2] === "{") {
      const close = source.indexOf("}", start + 3);
      if (close === -1) return undefined;
      const digits = source.slice(start + 3, close);
      if (!/^[\dA-Fa-f]{1,6}$/u.test(digits)) return undefined;
      const value = Number.parseInt(digits, 16);
      return value > 0x10ffff ? undefined : { text: String.fromCodePoint(value), end: close + 1 };
    }
    const value = hexadecimalValue(source, start + 2, 4);
    return value === undefined ? undefined : { text: String.fromCodePoint(value), end: start + 6 };
  }
  if (/[1-9]/u.test(escaped)) return undefined;
  return { text: escaped, end: start + 2 };
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
    if (char === "`") {
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
    if (char === "\\") {
      const cooked = cookedEscape(source, index);
      if (cooked === undefined) return undefined;
      sql += cooked.text;
      for (let offset = 0; offset < cooked.text.length; offset += 1) sqlOffsetMap.push(index);
      index = cooked.end;
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
    else if (char === "(") {
      depth += 1;
      index += 1;
    } else if (char === ")") {
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

function unwrappedRange(source: string, start: number, end: number): { readonly start: number; readonly end: number } {
  let range = trimmedRange(source, start, end);
  while (source[range.start] === "(" && closingParenthesis(source, range.start) === range.end - 1) {
    range = trimmedRange(source, range.start + 1, range.end - 1);
  }
  return range;
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

interface ConditionalRanges {
  readonly condition: { readonly start: number; readonly end: number };
  readonly truthy: { readonly start: number; readonly end: number };
  readonly falsy: { readonly start: number; readonly end: number };
}

function conditionalRanges(source: string, start: number, end: number): ConditionalRanges | undefined {
  let question: number | undefined;
  let colon: number | undefined;
  let round = 0;
  let square = 0;
  let curly = 0;
  let index = start;
  while (index < end) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (
      round === 0 &&
      square === 0 &&
      curly === 0 &&
      char === "?" &&
      source[index + 1] !== "." &&
      source[index + 1] !== "?" &&
      source[index - 1] !== "?" &&
      question === undefined
    )
      question = index;
    else if (round === 0 && square === 0 && curly === 0 && char === ":" && question !== undefined) {
      colon = index;
      break;
    }
    index += 1;
  }
  if (question === undefined || colon === undefined) return undefined;
  return {
    condition: unwrappedRange(source, start, question),
    truthy: unwrappedRange(source, question + 1, colon),
    falsy: unwrappedRange(source, colon + 1, end),
  };
}

function fragmentListError(
  source: string,
  start: number,
  end: number,
  code: Extract<RepeatedFragmentDiscovery, { readonly kind: "error" }>["code"],
  message: string,
  suggestion: string,
): RepeatedFragmentDiscovery {
  return { kind: "error", code, message, suggestion, range: positionRange(source, start, end) };
}

function splitTopLevel(source: string, start: number, end: number): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let itemStart = start;
  let round = 0;
  let square = 0;
  let curly = 0;
  let index = start;
  while (index < end) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") index = skipQuoted(source, index, char);
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else {
      if (char === "(") round += 1;
      else if (char === ")") round -= 1;
      else if (char === "[") square += 1;
      else if (char === "]") square -= 1;
      else if (char === "{") curly += 1;
      else if (char === "}") curly -= 1;
      else if (char === "," && round === 0 && square === 0 && curly === 0) {
        ranges.push(trimmedRange(source, itemStart, index));
        itemStart = index + 1;
      }
      index += 1;
    }
  }
  ranges.push(trimmedRange(source, itemStart, end));
  return ranges;
}

function topLevelArrow(source: string, start: number, end: number): number | undefined {
  let round = 0;
  let square = 0;
  let curly = 0;
  let index = start;
  while (index < end - 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") index = skipQuoted(source, index, char);
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else {
      if (char === "(") round += 1;
      else if (char === ")") round -= 1;
      else if (char === "[") square += 1;
      else if (char === "]") square -= 1;
      else if (char === "{") curly += 1;
      else if (char === "}") curly -= 1;
      else if (char === "=" && source[index + 1] === ">" && round === 0 && square === 0 && curly === 0) return index;
      index += 1;
    }
  }
  return undefined;
}

function directMapCallbackRange(
  source: string,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } | undefined {
  let round = 0;
  let square = 0;
  let curly = 0;
  let index = start;
  while (index < end) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") index = skipQuoted(source, index, char);
    else if (char === "/" && source[index + 1] === "/") index = skipLineComment(source, index);
    else if (char === "/" && source[index + 1] === "*") index = skipBlockComment(source, index);
    else {
      if (char === "(") round += 1;
      else if (char === ")") round -= 1;
      else if (char === "[") square += 1;
      else if (char === "]") square -= 1;
      else if (char === "{") curly += 1;
      else if (char === "." && round === 0 && square === 0 && curly === 0 && source.startsWith(".map", index)) {
        const open = skipTrivia(source, index + 4);
        if (source[open] !== "(") return undefined;
        const close = closingParenthesis(source, open);
        if (close === undefined || skipTrivia(source, close + 1) !== end || index === start) return undefined;
        const arguments_ = [...splitTopLevel(source, open + 1, close)];
        if (arguments_.at(-1)?.start === arguments_.at(-1)?.end) arguments_.pop();
        return arguments_.length === 1 ? arguments_[0] : undefined;
      }
      index += 1;
    }
  }
  return undefined;
}

function callbackBodyRange(
  source: string,
  callback: { readonly start: number; readonly end: number },
): { readonly body?: { readonly start: number; readonly end: number }; readonly async: boolean } {
  const text = source.slice(callback.start, callback.end);
  if (/^async\b/u.test(text)) return { async: true };
  const arrow = topLevelArrow(source, callback.start, callback.end);
  if (arrow === undefined) return { async: false };
  let body = unwrappedRange(source, arrow + 2, callback.end);
  if (source[body.start] === "{" && source[body.end - 1] === "}") {
    const block = source.slice(body.start + 1, body.end - 1).trim();
    const match = /^return\s+([\s\S]*?);?$/u.exec(block);
    if (match === null) return { async: false };
    const returnStart = source.indexOf(match[1]!, body.start + 1);
    body = unwrappedRange(source, returnStart, returnStart + match[1]!.length);
  }
  return { async: false, body };
}

function sameFragmentSkeleton(
  source: string,
  left: StructuralOperand,
  right: StructuralOperand,
  tagName: string,
): boolean {
  const placeholder = (index: number) => `?${index}`;
  const leftQuery = extractStructuralOperand(source, left, tagName, placeholder, 0);
  const rightQuery = extractStructuralOperand(source, right, tagName, placeholder, 0);
  return leftQuery !== undefined && rightQuery !== undefined && leftQuery.sql === rightQuery.sql;
}

export function discoverRepeatedFragmentInterpolation(
  source: string,
  interpolation: ExtractedInterpolation,
  tagName: string,
): RepeatedFragmentDiscovery {
  const expression = unwrappedRange(source, interpolation.expressionStart, interpolation.expressionEnd);
  if (source[expression.start] === "[" && source[expression.end - 1] === "]") {
    const elements = [...splitTopLevel(source, expression.start + 1, expression.end - 1)];
    if (elements.length > 1 && elements.at(-1)?.start === elements.at(-1)?.end) elements.pop();
    if (elements.length === 1 && elements[0]!.start === elements[0]!.end) {
      return fragmentListError(
        source,
        expression.start,
        expression.end,
        "TSQ008",
        "An implicit SQL fragment list cannot be empty.",
        "Use sql.value([]), sql.join(...), or sql.empty to choose the empty behavior explicitly.",
      );
    }
    if (elements.some((element) => element.start === element.end)) {
      return fragmentListError(
        source,
        expression.start,
        expression.end,
        "TSQ013",
        "Sparse fragment lists are unsupported.",
        "Build a dense fragment array.",
      );
    }
    if (elements.some((element) => source[element.start] === "[")) {
      return fragmentListError(
        source,
        expression.start,
        expression.end,
        "TSQ010",
        "Nested fragment lists are unsupported.",
        "Flatten fragments explicitly or bind the complete value with sql.value(...).",
      );
    }
    const fragments = elements.map((element) => structuralOperand(source, element.start, element.end, tagName));
    const fragmentCount = fragments.filter((element) => element?.kind === "fragment").length;
    if (fragmentCount === 0) {
      return elements.some((element) => source.slice(element.start, element.end).includes(".fragment`"))
        ? fragmentListError(
            source,
            expression.start,
            expression.end,
            "TSQ014",
            "The fragment list uses a different SQL tag.",
            "Create every fragment with the selected grammar's sql.fragment tag.",
          )
        : { kind: "none" };
    }
    if (fragmentCount !== elements.length) {
      return fragmentListError(
        source,
        expression.start,
        expression.end,
        "TSQ009",
        "A fragment list cannot mix SQL fragments and values.",
        "Use only sql.fragment elements or bind the complete array with sql.value(...).",
      );
    }
    return {
      kind: "fragments",
      dynamic: false,
      representativeItems: 1,
      elements: fragments as readonly StructuralOperand[],
      range: positionRange(source, expression.start, expression.end),
    };
  }

  const callback = directMapCallbackRange(source, expression.start, expression.end);
  if (callback === undefined) {
    const text = source.slice(expression.start, expression.end);
    if (text.includes(".fragment`") && (text.includes(".flatMap") || text.includes(".map"))) {
      return fragmentListError(
        source,
        expression.start,
        expression.end,
        "TSQ013",
        "This dynamic fragment-list expression is not analyzable.",
        "Use a direct .map(...) call with a synchronous sql.fragment callback, or use sql.join explicitly.",
      );
    }
    return { kind: "none" };
  }
  const callbackBody = callbackBodyRange(source, callback);
  if (callbackBody.async) {
    return fragmentListError(
      source,
      callback.start,
      callback.end,
      "TSQ011",
      "A fragment-list callback cannot be async.",
      "Resolve inputs first and return sql.fragment synchronously.",
    );
  }
  if (callbackBody.body === undefined) {
    return source.slice(callback.start, callback.end).includes(".fragment`")
      ? fragmentListError(
          source,
          callback.start,
          callback.end,
          "TSQ013",
          "The fragment-list callback control flow is not analyzable.",
          "Return one stable sql.fragment expression directly from the callback.",
        )
      : { kind: "none" };
  }
  const conditional = conditionalRanges(source, callbackBody.body.start, callbackBody.body.end);
  const ranges = conditional === undefined ? [callbackBody.body] : [conditional.truthy, conditional.falsy];
  const fragments = ranges.map((range) => structuralOperand(source, range.start, range.end, tagName));
  const fragmentCount = fragments.filter((operand) => operand?.kind === "fragment").length;
  if (fragmentCount === 0) {
    return source.slice(callbackBody.body.start, callbackBody.body.end).includes(".fragment`")
      ? fragmentListError(
          source,
          callbackBody.body.start,
          callbackBody.body.end,
          "TSQ014",
          "The callback returns a fragment from a different SQL tag.",
          "Use the selected grammar's sql.fragment tag.",
        )
      : { kind: "none" };
  }
  if (fragmentCount !== ranges.length) {
    return fragmentListError(
      source,
      callbackBody.body.start,
      callbackBody.body.end,
      "TSQ009",
      "Every callback path must return a SQL fragment.",
      "Return one stable sql.fragment skeleton from every callback path.",
    );
  }
  if (fragments.length === 2 && !sameFragmentSkeleton(source, fragments[0]!, fragments[1]!, tagName)) {
    return fragmentListError(
      source,
      callbackBody.body.start,
      callbackBody.body.end,
      "TSQ012",
      "Fragment callback paths render different SQL skeletons.",
      "Use one stable fragment skeleton or an explicit sql.join composition.",
    );
  }
  return {
    kind: "fragments",
    dynamic: true,
    representativeItems: 2,
    elements: fragments as readonly StructuralOperand[],
    range: positionRange(source, expression.start, expression.end),
  };
}

function bareTemplateRange(source: string, start: number, end: number): SourceRange | undefined {
  const range = unwrappedRange(source, start, end);
  if (source[range.start] !== "`" || skipQuoted(source, range.start, "`") !== range.end) return undefined;
  return positionRange(source, range.start, range.end);
}

export function findUntaggedStructuralTemplates(
  source: string,
  query: ExtractedQuery,
): readonly UntaggedStructuralTemplate[] {
  const templates: UntaggedStructuralTemplate[] = [];
  for (const interpolation of query.interpolations) {
    const expression = unwrappedRange(source, interpolation.expressionStart, interpolation.expressionEnd);
    const conditional = conditionalRanges(source, expression.start, expression.end);
    if (conditional === undefined) continue;
    const truthyStructural = structuralOperand(source, conditional.truthy.start, conditional.truthy.end, query.tagName);
    const falsyStructural = structuralOperand(source, conditional.falsy.start, conditional.falsy.end, query.tagName);
    const truthyTemplate = bareTemplateRange(source, conditional.truthy.start, conditional.truthy.end);
    const falsyTemplate = bareTemplateRange(source, conditional.falsy.start, conditional.falsy.end);
    if (truthyTemplate !== undefined && falsyStructural !== undefined) {
      templates.push({ tagName: query.tagName, range: truthyTemplate });
    }
    if (falsyTemplate !== undefined && truthyStructural !== undefined) {
      templates.push({ tagName: query.tagName, range: falsyTemplate });
    }
  }
  return templates;
}

export function parseStructuralInterpolation(
  source: string,
  interpolation: ExtractedInterpolation,
  tagName: string,
): StructuralInterpolation | undefined {
  const expression = unwrappedRange(source, interpolation.expressionStart, interpolation.expressionEnd);
  const { start, end } = expression;
  const conditional = conditionalRanges(source, start, end);
  if (conditional === undefined) {
    const truthy = structuralOperand(source, start, end, tagName);
    return truthy === undefined ? undefined : { truthy };
  }
  const truthy = structuralOperand(source, conditional.truthy.start, conditional.truthy.end, tagName);
  const falsy = structuralOperand(source, conditional.falsy.start, conditional.falsy.end, tagName);
  if (truthy === undefined || falsy === undefined) return undefined;
  return {
    condition: source.slice(conditional.condition.start, conditional.condition.end).replace(/\s+/gu, " "),
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
    if (char === '"' || char === "'") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "`") {
      index = skipQuoted(source, index, "`");
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
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

/** Find code identifiers without treating quoted text or comments as member calls. */
function nextCodeIdentifier(source: string, start: number): ReturnType<typeof identifierAt> {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    const tag = identifierAt(source, index);
    if (tag === undefined) {
      index += 1;
      continue;
    }
    return tag;
  }
  return undefined;
}

/** Locates explicit `sql.dynamic(...)` escape hatches without reading their runtime value. */
export function extractDynamicQueries(
  source: string,
  sqlModules: readonly string[] = ["@typed-sql/core"],
): readonly ExtractedDynamicQuery[] {
  const names = importedSqlNames(source, new Set(sqlModules));
  if (names.size === 0) return [];
  const queries: ExtractedDynamicQuery[] = [];
  let index = 0;
  while (index < source.length) {
    const tag = nextCodeIdentifier(source, index);
    if (tag === undefined) break;
    index = tag.end;
    if (!names.has(tag.value)) continue;
    let cursor = skipTrivia(source, tag.end);
    if (source[cursor] !== ".") continue;
    cursor = skipTrivia(source, cursor + 1);
    const member = identifierAt(source, cursor);
    if (member?.value !== "dynamic") continue;
    cursor = skipTrivia(source, member.end);
    if (source[cursor] !== "(") continue;
    const close = closingParenthesis(source, cursor);
    const end = close === undefined ? member.end : close + 1;
    queries.push({ tagName: tag.value, range: positionRange(source, tag.end - tag.value.length, end) });
    index = end;
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
    const tag = nextCodeIdentifier(source, index);
    if (tag === undefined) break;
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
    if (baseName === undefined) {
      index = close + 1;
      continue;
    }
    const base = bindings
      .filter((binding) => binding.name === baseName.value && binding.query.range.start < index)
      .sort((left, right) => right.query.range.start - left.query.range.start)[0]?.query;
    argument = skipTrivia(source, baseName.end);
    if (base === undefined || source[argument] !== ",") {
      index = close + 1;
      continue;
    }

    let fragmentCursor = argument + 1;
    const prefix: ExtractedQuery[] = [];
    let parameterOffset = base.parameterCount;
    while (fragmentCursor < close) {
      const fragmentChar = source[fragmentCursor];
      if (fragmentChar === '"' || fragmentChar === "'") {
        fragmentCursor = skipQuoted(source, fragmentCursor, fragmentChar);
        continue;
      }
      if (fragmentChar === "`") {
        fragmentCursor = skipQuoted(source, fragmentCursor, fragmentChar);
        continue;
      }
      if (fragmentChar === "/" && source[fragmentCursor + 1] === "/") {
        fragmentCursor = skipLineComment(source, fragmentCursor);
        continue;
      }
      if (fragmentChar === "/" && source[fragmentCursor + 1] === "*") {
        fragmentCursor = skipBlockComment(source, fragmentCursor);
        continue;
      }
      const fragmentTag = identifierAt(source, fragmentCursor);
      if (fragmentTag === undefined) {
        fragmentCursor += 1;
        continue;
      }
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
