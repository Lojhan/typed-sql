import assert from "node:assert/strict";

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
function tokenDeclarations(source) {
  const block = /\btokens\s*\{([\s\S]*?)^\}/gmu.exec(source);
  assert.ok(block, "Missing ScriptDOM token declarations");
  const entries = [];
  const rest = withoutComments(block[1]).replace(/\b([A-Za-z_]\w*)\s*(?:=\s*"([a-z_]+)")?\s*;/gu, (_, token, word) => {
    if (word !== undefined) entries.push([word, token]);
    return "";
  });
  assert.match(rest, /^\s*$/u, "Unfamiliar ScriptDOM token declaration");
  assert.ok(entries.length);
  assert.equal(new Set(entries.map(([word]) => word)).size, entries.length);
  return entries;
}

/** Extract source declarations, not an assertion that this external parser equals the engine. */
export function parseSqlServerVocabulary(commonTokens, parser, constants, major) {
  assert.ok([14, 15, 16, 17].includes(major), "Unknown ScriptDOM parser profile");
  const lexer = parser.slice(
    parser.indexOf(`class TSql${major}0LexerInternal extends Lexer("TSqlLexerBaseInternal");`),
  );
  assert.ok(lexer.startsWith("class "), "Missing version-owned ScriptDOM lexer");
  assert.match(lexer, /caseSensitive\s*=\s*false\s*;/u);
  assert.match(lexer, /caseSensitiveLiterals\s*=\s*false\s*;/u);
  assert.match(lexer, /importVocab\s*=\s*TSql\s*;/u);
  assert.match(
    parser,
    /^identifier returns \[Identifier[^\n]+\]\s*:\s*\w+:Identifier\s*\{[^{}]*\}\s*\|\s*\w+:QuotedIdentifier\s*\{[^{}]*\}\s*;/gmu,
    "Unfamiliar ScriptDOM identifier permissions",
  );
  const tokens = [...tokenDeclarations(commonTokens), ...tokenDeclarations(lexer)];
  const reserved = new Map(tokens);
  assert.equal(reserved.size, tokens.length, "Overlapping ScriptDOM literal declarations");
  const symbols = new Map(),
    nonWords = [],
    names = new Map();
  const declarations = [...constants.matchAll(/\binternal const string\s+(\w+)\s*=\s*("(?:\\.|[^"\\])*")\s*;/gu)];
  assert.equal(
    declarations.length,
    [...constants.matchAll(/\binternal const string\b/gu)].length,
    "Unfamiliar ScriptDOM string declaration",
  );
  assert.ok(declarations.length);
  for (const [, symbol, quoted] of declarations) {
    assert.ok(!symbols.has(symbol), "Duplicate ScriptDOM constant");
    const value = JSON.parse(quoted);
    symbols.set(symbol, value);
    if (/^[A-Za-z_][A-Za-z_0-9]*$/u.test(value)) {
      const name = value.toLowerCase();
      const entries = names.get(name) ?? [];
      entries.push(symbol);
      names.set(name, entries);
    } else nonWords.push([symbol, value]);
  }
  for (const name of reserved.keys()) if (!names.has(name)) names.set(name, []);
  const words = [...names].map(([name, symbols]) => [name, reserved.get(name) ?? null, symbols.sort()]);
  words.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { words, nonWords: nonWords.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
}
