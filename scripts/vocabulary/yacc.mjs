import assert from "node:assert/strict";

/** Read productions without executing or retaining vendor semantic actions. */
export function yaccProductions(source) {
  const separators = [...source.matchAll(/^%%\s*$/gmu)];
  assert.ok(separators.length >= 1, "Missing Yacc grammar section");
  const grammar = source.slice(separators[0].index + separators[0][0].length, separators[1]?.index);
  let index = 0,
    depth = 0,
    clean = "";
  while (index < grammar.length) {
    const char = grammar[index];
    assert.ok(!(depth > 0 && grammar.startsWith('R"', index)), "Unsupported raw source literal");
    if (grammar.startsWith("/*", index)) {
      const end = grammar.indexOf("*/", index + 2);
      assert.ok(end >= 0, "Unterminated source comment");
      clean += grammar.slice(index, end + 2).replace(/[^\n]/gu, " ");
      index = end + 2;
      continue;
    }
    if (grammar.startsWith("//", index)) {
      const end = grammar.indexOf("\n", index + 2);
      const next = end < 0 ? grammar.length : end;
      clean += grammar.slice(index, next).replace(/[^\n]/gu, " ");
      index = next;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index++,
        quote = char;
      while (index < grammar.length && grammar[index] !== quote) {
        if (grammar[index] === "\\") index++;
        index++;
      }
      assert.ok(index < grammar.length, "Unterminated source literal");
      index++;
      clean += depth ? grammar.slice(start, index).replace(/[^\n]/gu, " ") : grammar.slice(start, index);
      continue;
    }
    if (char === "{") {
      depth++;
      clean += " ";
    } else if (char === "}") {
      assert.ok(depth > 0, "Unexpected source action close");
      depth--;
      clean += " ";
    } else clean += depth && char !== "\n" ? " " : char;
    index++;
  }
  assert.equal(depth, 0, "Unterminated source action");
  const productions = new Map();
  for (const match of clean.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*([\s\S]*?)^\s*;\s*$/gmu)) {
    assert.ok(!productions.has(match[1]), "Duplicate grammar production");
    productions.set(
      match[1],
      match[2].split(/\s+\|\s+/u).map((body) => body.trim()),
    );
  }
  assert.ok(productions.size, "Missing source grammar productions");
  return productions;
}
