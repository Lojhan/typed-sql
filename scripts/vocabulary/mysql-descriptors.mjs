import assert from "node:assert/strict";
import { yaccProductions } from "./yacc.mjs";

/** Generate bounded witnesses for every column/cast alternative, including lexical aliases. */
export function mySqlDescriptorTypes(lex, yacc) {
  const words = new Map();
  for (const match of lex.matchAll(
    /\{\s*SYM(?:_FN|_HK|_H)?\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*([A-Za-z_0-9]+)\s*\)\s*\}/gu,
  )) {
    if (!words.has(match[2])) words.set(match[2], []);
    if (!words.get(match[2]).includes(match[1])) words.get(match[2]).push(match[1]);
  }
  assert.ok(words.size, "Missing MySQL lexical declarations");
  const productions = yaccProductions(yacc);
  const symbols = (body) =>
    body
      .replace(/%prec\s+[A-Z_0-9]+/gu, "")
      .replace(/%empty/gu, "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
  const rules = new Map([...productions].map(([name, alternatives]) => [name, alternatives.map(symbols)]));
  // These are terminal value classes, not type names. No expression is executed to derive a type.
  const best = new Map([
    ["NUM", ["8"]],
    ["LONG_NUM", ["8"]],
    ["ULONGLONG_NUM", ["8"]],
    ["DECIMAL_NUM", ["8"]],
    ["TEXT_STRING", ["'value'"]],
  ]);
  for (const [token, names] of words) best.set(token, [names[0]]);
  const literal = (symbol) => (/^'[^'\\]+'$/u.test(symbol) ? [symbol.slice(1, -1)] : undefined);
  const minimum = (symbol) => best.get(symbol) ?? literal(symbol);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, alternatives] of rules) {
      for (const body of alternatives) {
        const pieces = body.map(minimum);
        if (pieces.some((piece) => piece === undefined)) continue;
        const candidate = pieces.flat();
        if (!best.has(name) || candidate.length < best.get(name).length) {
          best.set(name, candidate);
          changed = true;
        }
      }
    }
  }
  // Expand finite keyword-only productions completely (type heads and multiword aliases).
  // Recursive/options/value-bearing productions use their shortest concrete witness instead.
  const lexical = (symbol, active = new Set()) => {
    if (words.has(symbol)) return true;
    if (active.has(symbol) || !rules.has(symbol)) return false;
    const next = new Set([...active, symbol]);
    return rules.get(symbol).every((body) => body.every((part) => lexical(part, next)));
  };
  const product = (pieces) => {
    let rows = [[]];
    for (const variants of pieces) {
      assert.ok(rows.length * variants.length <= 20000, "Unbounded MySQL type witness expansion");
      rows = rows.flatMap((prefix) => variants.map((suffix) => [...prefix, ...suffix]));
    }
    return rows;
  };
  const expand = (symbol) => {
    if (words.has(symbol)) return words.get(symbol).map((word) => [word]);
    if (lexical(symbol)) return rules.get(symbol).flatMap((body) => product(body.map(expand)));
    const value = minimum(symbol);
    assert.ok(value, `No bounded MySQL type witness for ${symbol}`);
    return [value];
  };
  const cases = new Map(),
    alternatives = [];
  for (const [root, kind] of [
    ["type", "column"],
    ["cast_type", "cast"],
  ]) {
    assert.ok(rules.has(root), `Missing MySQL ${root} production`);
    for (const [index, body] of rules.get(root).entries()) {
      const identity = `${root}:${index}`;
      alternatives.push({ id: identity, symbols: body });
      const witnesses = product(body.map(expand));
      assert.ok(witnesses.length);
      for (const witness of witnesses) {
        const type = witness.join(" ");
        assert.ok(type.length > 0 && type.length <= 1024);
        const key = `${kind}:${type}`;
        if (!cases.has(key)) cases.set(key, { kind, type, alternatives: [] });
        cases.get(key).alternatives.push(identity);
      }
    }
  }
  assert.deepEqual(
    [...new Set([...cases.values()].flatMap(({ alternatives }) => alternatives))].sort(),
    alternatives.map(({ id }) => id).sort(),
  );
  return {
    alternatives,
    cases: [...cases.values()].sort((a, b) => `${a.kind}:${a.type}`.localeCompare(`${b.kind}:${b.type}`)),
  };
}
