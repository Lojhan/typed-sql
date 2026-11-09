import assert from "node:assert/strict";
import { yaccProductions } from "./yacc.mjs";

/** Extract declarations as facts; never copy vendor parser actions into the analyzer. */
export function parseMySqlVocabulary(lex, yacc, generator, registry) {
  // These are the native generator's reservation and namespace rules. A changed rule needs review.
  assert.ok(
    /keyword_semantic_type\("<lexer\.keyword>"\)/u.test(generator),
    "Unknown MySQL reservation annotation rule",
  );
  assert.ok(
    /sym->group != SG_KEYWORDS && sym->group != SG_HINTABLE_KEYWORDS/u.test(generator),
    "Unknown MySQL keyword namespace rule",
  );
  assert.ok(
    /(?:keyword_tokens\.count\(sym->tok\) == 0|!keyword_tokens\.contains\(sym->tok\))/u.test(generator),
    "Unknown MySQL reservation membership rule",
  );
  const tokens = new Map();
  for (const line of yacc.split(/\r?\n/u).filter((line) => /^%token\b/u.test(line))) {
    const match = /^%token\s*(<[_a-zA-Z0-9.]+>)?\s*([A-Z_a-z0-9]+)\s+(\d+)\b.*$/u.exec(line);
    assert.ok(match, "Unrecognized MySQL token declaration");
    assert.ok(!tokens.has(match[2]), "Duplicate MySQL token declaration");
    tokens.set(match[2], { reserved: match[1] !== "<lexer.keyword>", number: Number(match[3]) });
  }
  assert.ok(tokens.size, "Missing MySQL grammar tokens");
  const productions = yaccProductions(yacc),
    functionHeads = new Set(),
    bareFunctions = new Set();
  const symbols = (body) =>
    body
      .replace(/%prec\s+[A-Z_0-9]+/gu, "")
      .replace(/%empty/gu, "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
  const nullable = new Set();
  for (let previous = -1; previous !== nullable.size; ) {
    previous = nullable.size;
    for (const [name, alternatives] of productions)
      if (alternatives.some((body) => symbols(body).every((symbol) => nullable.has(symbol)))) nullable.add(name);
  }
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const alternatives = productions.get(name);
    assert.ok(alternatives, `Missing MySQL ${name} production`);
    for (const alternative of alternatives) {
      const body = symbols(alternative),
        head = body[0];
      if (
        head &&
        /^[A-Z_0-9]+$/u.test(head) &&
        ["'('", "optional_braces", "func_datetime_precision"].includes(body[1])
      ) {
        functionHeads.add(head);
        if (body.slice(1).every((symbol) => nullable.has(symbol))) bareFunctions.add(head);
      } else if (head && productions.has(head)) visit(head);
    }
  };
  for (const name of [
    "function_call_keyword",
    "function_call_nonkeyword",
    "function_call_conflict",
    "sum_expr",
    "window_func_call",
    "simple_expr",
  ])
    visit(name);
  const infix = new Set();
  for (const name of ["expr", "bool_pri", "predicate", "bit_expr", "simple_expr"]) {
    const alternatives = productions.get(name);
    assert.ok(alternatives, `Missing MySQL ${name} operator context`);
    for (const alternative of alternatives) {
      const body = symbols(alternative);
      if (productions.has(body[0]) && /^[A-Z_0-9]+$/u.test(body[1] ?? "")) infix.add(body[1]);
    }
  }
  const registryTable = /func_array\[\]\s*=\s*\{([\s\S]*?)\};/u.exec(registry);
  assert.ok(registryTable, "Missing MySQL ordinary native function registry");
  const registryBody = registryTable[1]
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/#ifndef NDEBUG[\s\S]*?#endif/gu, "");
  const ordinaryFunctions = new Set();
  const registryRest = registryBody.replace(/\{\s*"([A-Z_0-9]+)"\s*,[^{}]+\}/gu, (_, name) => {
    assert.ok(!ordinaryFunctions.has(name), "Duplicate native function registry entry");
    ordinaryFunctions.add(name);
    return "";
  });
  assert.ok(/^[\s,]*$/u.test(registryRest), "Unsupported MySQL native registry declaration");
  const clean = lex.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const table = /static const SYMBOL symbols\[\]\s*=\s*\{([\s\S]*?)\};/u.exec(clean);
  assert.ok(table, "Missing MySQL symbol table");
  const records = [],
    hints = [];
  const remaining = table[1].replace(
    /\{\s*(SYM(?:_FN|_HK|_H)?)\(\s*"([^"\n]+)"\s*,\s*([A-Za-z_0-9]+)\s*\)\s*\}/gu,
    (_, macro, name, token) => {
      if (!/^[A-Za-z]/u.test(name)) return ""; // Native keyword API excludes operators.
      assert.match(name, /^[A-Z_0-9]+$/u);
      if (macro === "SYM_H") {
        hints.push([name, token]);
        return "";
      }
      assert.ok(tokens.has(token), `Undeclared MySQL keyword token ${token}`);
      const group = macro === "SYM_FN" ? "function" : macro === "SYM_HK" ? "hintable" : "keyword";
      records.push([
        name,
        token,
        tokens.get(token).reserved,
        group,
        functionHeads.has(token),
        bareFunctions.has(token),
        ordinaryFunctions.has(name),
        infix.has(token),
      ]);
      return "";
    },
  );
  assert.match(remaining, /^[\s,]*$/u, "Unrecognized MySQL symbol table entry");
  assert.equal(new Set(records.map(([name]) => name)).size, records.length, "Duplicate MySQL vocabulary name");
  assert.equal(new Set(hints.map(([name]) => name)).size, hints.length, "Duplicate MySQL hint name");
  const compare = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  return { words: records.sort(compare), hints: hints.sort(compare) };
}
