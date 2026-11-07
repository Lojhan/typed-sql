function triviaEnd(source, start) {
  if (source.startsWith("/*", start)) {
    const end = source.indexOf("*/", start + 2);
    if (end < 0) throw new TypeError("Unclosed PostgreSQL grammar comment");
    return end + 2;
  }
  if (source.startsWith("//", start)) {
    const end = source.indexOf("\n", start + 2);
    return end < 0 ? source.length : end + 1;
  }
  const character = source[start];
  if (character === '"' || character === "'") {
    let cursor = start + 1;
    while (cursor < source.length) {
      const next = source[cursor++];
      if (next === "\\") cursor++;
      else if (next === character) return cursor;
    }
    throw new TypeError("Unclosed PostgreSQL grammar literal");
  }
  return undefined;
}

/** Read a balanced C action without treating braces in comments/literals as delimiters. */
function action(source, start) {
  let cursor = start + 1,
    depth = 1;
  while (cursor < source.length) {
    const skip = triviaEnd(source, cursor);
    if (skip !== undefined) {
      cursor = skip;
      continue;
    }
    const character = source[cursor++];
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return { body: source.slice(start + 1, cursor - 1), end: cursor };
  }
  throw new TypeError("Unclosed PostgreSQL grammar action");
}

/** Only unconditional direct, single-target aliases are qualified; conditional productions stay unknown. */
export function grammarTypeAliases(grammar, keywords, typeNames) {
  const tokens = new Map(keywords.map(({ token, name }) => [token, name]));
  const result = new Map();
  const pieces = [];
  let cursor = 0,
    first = 0;
  while (cursor < grammar.length) {
    const end = triviaEnd(grammar, cursor);
    if (end === undefined) {
      cursor++;
      continue;
    }
    pieces.push(grammar.slice(first, cursor), grammar.slice(cursor, end).replace(/[^\r\n]/g, " "));
    cursor = end;
    first = end;
  }
  pieces.push(grammar.slice(first));
  const masked = pieces.join("");
  const pattern = /\b([A-Z][A-Z_0-9]*)\s*\{/gu;
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
    const parsed = action(grammar, pattern.lastIndex - 1);
    pattern.lastIndex = parsed.end;
    const body = parsed.body.replace(/\/\*[\s\S]*?\*\//gu, "");
    const direct = /^\s*\$\$\s*=\s*SystemTypeName\("([a-z_0-9]+)"\)\s*;/u.exec(body);
    if (!direct || [...body.matchAll(/\bSystemTypeName\s*\(/gu)].length !== 1) continue;
    const rest = body.slice(direct[0].length).trim();
    if (rest && !/^\$\$\s*->\s*location\s*=\s*@\d+\s*;\s*$/u.test(rest)) continue;
    const name = tokens.get(match[1]),
      canonical = typeNames.get(direct[1]);
    if (!name || !canonical) continue;
    if (
      (result.has(name) && result.get(name) !== canonical) ||
      (typeNames.has(name) && typeNames.get(name) !== canonical)
    )
      throw new TypeError("Conflicting PostgreSQL grammar type alias");
    result.set(name, canonical);
  }
  return result;
}
