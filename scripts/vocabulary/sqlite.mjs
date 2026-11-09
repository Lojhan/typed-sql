import assert from "node:assert/strict";

export const not = (value) => (typeof value === "boolean" ? !value : ["not", value]);
const combine = (op, left, right) => {
  if (left === right) return left;
  if (op === "and" && (left === false || right === false)) return false;
  if (op === "or" && (left === true || right === true)) return true;
  if (left === (op === "and")) return right;
  if (right === (op === "and")) return left;
  return [op, left, right];
};
export const and = (left, right) => combine("and", left, right);
const or = (left, right) => combine("or", left, right);

/** Bounded source condition parser; unfamiliar preprocessor expressions require review. */
export function sqliteCondition(source) {
  const text = source.replace(/defined\s*\(\s*(SQLITE_[A-Z_0-9]+)\s*\)/gu, "$1");
  const tokens = text.match(/SQLITE_[A-Z_0-9]+|&&|\|\||[!()]/gu) ?? [];
  assert.equal(tokens.join(""), text.replace(/\s/gu, ""), "Unsupported SQLite source condition");
  let index = 0;
  const atom = () => {
    const token = tokens[index++];
    if (token === "!") return not(atom());
    if (token === "(") {
      const value = disjunction();
      assert.equal(tokens[index++], ")");
      return value;
    }
    assert.match(token ?? "", /^SQLITE_[A-Z_0-9]+$/u);
    return token.slice(7);
  };
  const conjunction = () => {
    let value = atom();
    while (tokens[index] === "&&") {
      index++;
      value = and(value, atom());
    }
    return value;
  };
  const disjunction = () => {
    let value = conjunction();
    while (tokens[index] === "||") {
      index++;
      value = or(value, conjunction());
    }
    return value;
  };
  const result = disjunction();
  assert.equal(index, tokens.length);
  return result;
}
function conditions() {
  const stack = [];
  return {
    directive(kind, value) {
      if (["if", "ifdef", "ifndef"].includes(kind)) {
        const condition = sqliteCondition(value);
        stack.push(kind === "ifndef" ? not(condition) : condition);
      } else if (kind === "else") {
        assert.ok(stack.length);
        stack[stack.length - 1] = not(stack.at(-1));
      } else if (kind === "endif") assert.ok(stack.pop() !== undefined);
      else throw Error("Unsupported SQLite condition directive");
    },
    value: () => stack.reduce(and, true),
    finish: () => assert.equal(stack.length, 0, "Unbalanced SQLite source condition"),
  };
}
const uncomment = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
export function parseSqliteVocabulary(keywords, grammar, tokenizer) {
  const clean = uncomment(keywords).replace(/\\\r?\n/gu, " ");
  const table = /static Keyword aKeywordTable\[\]\s*=\s*\{([\s\S]*?)\n\};/u.exec(clean);
  assert.ok(table, "Missing SQLite keyword table");
  const masks = {},
    guards = conditions();
  const prefix = clean.slice(clean.indexOf("#if"), table.index);
  for (const line of prefix.split(/\r?\n/u).filter((line) => line.trim())) {
    const directive = /^\s*#\s*(if|ifdef|ifndef|else|endif)\b\s*(.*)$/u.exec(line);
    if (directive) {
      guards.directive(directive[1], directive[2]);
      continue;
    }
    const define = /^\s*#\s*define\s+([A-Z_]+)\s+(0x[a-fA-F0-9]+|0)\s*$/u.exec(line);
    assert.ok(define, "Unrecognized SQLite keyword mask definition");
    if (Number(define[2])) {
      assert.equal(masks[define[1]], undefined);
      masks[define[1]] = guards.value();
    }
  }
  guards.finish();
  const parse = uncomment(grammar);
  const fallback = /%fallback ID\s+([\s\S]*?)\s+\./u.exec(parse);
  assert.ok(fallback, "Missing SQLite identifier fallback declarations");
  const fallbacks = {},
    fallbackGuards = conditions();
  for (const line of fallback[1].split(/\r?\n/u).filter((line) => line.trim())) {
    const directive = /^\s*%(ifdef|ifndef|else|endif)\b\s*(.*)$/u.exec(line);
    if (directive) {
      fallbackGuards.directive(directive[1], directive[2].split(/\s/u)[0]);
      continue;
    }
    assert.match(line, /^\s*[A-Z_]+(?:\s+[A-Z_]+)*\s*$/u);
    for (const token of line.trim().split(/\s+/u))
      fallbacks[token] = or(fallbacks[token] ?? false, fallbackGuards.value());
  }
  fallbackGuards.finish();
  const classes = Object.fromEntries(
    [...parse.matchAll(/%token_class (\w+)\s+([A-Z_|]+)\./gu)].map((match) => [match[1], match[2].split("|")]),
  );
  const expand = (name) => {
    if (/^[A-Z_]+$/u.test(name)) return [name];
    assert.ok(classes[name], "Unknown SQLite identifier token class");
    return classes[name];
  };
  const nameProductions = [...parse.matchAll(/^nm\(A\) ::= (\w+)\(A\)\./gmu)];
  assert.ok(nameProductions.length);
  assert.equal(
    parse.split(/\r?\n/u).filter((line) => /^nm\(A\)\s*::=/u.test(line)).length,
    nameProductions.length,
    "Unrecognized SQLite name production",
  );
  const names = nameProductions.flatMap((match) => expand(match[1]));
  const expression = /^expr\(A\) ::= (\w+)\(X\)\.\s*\{A=tokenExpr\(pParse,TK_ID,X\);/mu.exec(parse);
  assert.ok(expression, "Missing SQLite identifier expression production");
  const expressionNames = expand(expression[1]);
  assert.ok(classes.ids, "Missing SQLite bare alias class");
  assert.match(parse, /as\(X\) ::= AS nm\(Y\)\./u);
  assert.match(parse, /as\(X\) ::= ids\(X\)\./u);
  const contextual = new Set(
    [
      ...tokenizer.matchAll(/tokenType==TK_([A-Z_]+)\s*\)\s*\{\s*assert\([^;]+;\s*tokenType = (analyze\w+Keyword)\(/gu),
    ].map((m) => {
      const start = tokenizer.indexOf(`static int ${m[2]}(`);
      assert.ok(start >= 0, "Unrecognized contextual SQLite keyword classifier");
      const body = tokenizer.slice(start, tokenizer.indexOf("\n}", start));
      assert.match(body, /TK_ID/u);
      return m[1];
    }),
  );
  assert.ok(contextual.size, "Missing SQLite contextual keyword classifiers");
  const getTokenStart = tokenizer.indexOf("static int getToken(");
  assert.ok(getTokenStart >= 0);
  const getTokenBody = tokenizer.slice(getTokenStart, tokenizer.indexOf("\n}", getTokenStart));
  const lookahead = new Set([...getTokenBody.matchAll(/t==TK_([A-Z_]+)/gu)].map((match) => match[1]));
  assert.match(getTokenBody, /sqlite3ParserFallback\(t\)==TK_ID/u);
  const like = /^likeop\(A\) ::= ([A-Z_|]+)\(A\)\./mu.exec(parse);
  assert.ok(like, "Unknown SQLite pattern operator production");
  const patternOperators = new Set(like[1].split("|"));
  const rows = table[1]
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const record = /^\s*\{\s*"([A-Z_]+)",\s*"TK_([A-Z_]+)",\s*([A-Z_|]+),\s*\d+\s*\},?\s*$/u.exec(line);
      assert.ok(record, "Unsupported SQLite keyword declaration");
      const [, name, token, mask] = record;
      const groups = mask.split("|");
      for (const group of groups) assert.ok(group in masks, "Unknown SQLite keyword build mask");
      return [
        name,
        token,
        groups,
        fallbacks[token] ?? false,
        (expressionNames.includes(token) ? 1 : 0) |
          (classes.ids.includes(token) ? 2 : 0) |
          (names.includes(token) ? 4 : 0),
        contextual.has(token),
        lookahead.has(token),
        patternOperators.has(token),
      ];
    });
  assert.equal(new Set(rows.map(([name]) => name)).size, rows.length);
  return { words: rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), masks };
}
