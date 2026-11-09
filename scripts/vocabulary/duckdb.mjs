import assert from "node:assert/strict";
import { yaccProductions } from "./yacc.mjs";

const classes = [
  ["R", "reserved"],
  ["U", "unreserved"],
  ["C", "column_name"],
  ["F", "func_name"],
  ["T", "type_name"],
];
const normalize = (text) => text.trim().replace(/\s+/gu, " ");
const sorted = (values) => [...values].sort();

/** Preserve overlapping name permissions separately from the native API's display categories. */
export function parseDuckDBVocabulary(files, parser) {
  assert.ok(parser === "yacc" || parser === "peg", "Unknown DuckDB source parser");
  const prefix = parser === "yacc" ? "third_party/libpg_query/grammar/" : "src/parser/peg/grammar/";
  const list = (name) => {
    const path = `${prefix}keywords/${name}_${parser === "yacc" ? "keywords" : "keyword"}.list`;
    assert.equal(typeof files[path], "string", `Missing declaration list ${path}`);
    const tokens = files[path].split(/\r?\n/u).filter((line) => line.trim());
    assert.ok(tokens.length);
    const words = tokens.map((line) => {
      assert.match(line, /^(?:[A-Z][A-Z_0-9]*|[a-z][a-z_0-9]*)$/u, "Unfamiliar DuckDB keyword declaration");
      return (parser === "yacc" ? line.replace(/_P$/u, "") : line).toLowerCase();
    });
    assert.equal(new Set(words).size, words.length, "Duplicate DuckDB keyword declaration");
    return new Set(words);
  };
  const groups = new Map(classes.map(([key, name]) => [key, list(name)]));
  const names = sorted(new Set([...groups.values()].flatMap((words) => [...words])));
  for (const name of names) {
    const memberships = [...groups].filter(([, words]) => words.has(name)).map(([key]) => key);
    assert.ok(!memberships.includes("R") || memberships.length === 1, "Conflicting reserved keyword");
    assert.ok(!memberships.includes("U") || memberships.length === 1, "Conflicting unreserved keyword");
  }
  let bareLabels = [],
    functionClasses;
  if (parser === "yacc") {
    const common = yaccProductions(`%%\n${files[`${prefix}statements/common.y`]}\n`);
    const select = yaccProductions(`%%\n${files[`${prefix}statements/select.y`]}\n`);
    const expect = (name, alternatives) =>
      assert.deepEqual(
        (common.get(name) ?? select.get(name))?.map(normalize),
        alternatives,
        `Unfamiliar ${name} permissions`,
      );
    expect("ColId", ["IDENT", "unreserved_keyword", "col_name_keyword"]);
    expect("ColLabel", ["IDENT", "other_keyword", "unreserved_keyword", "reserved_keyword"]);
    expect("function_name_token", ["IDENT", "unreserved_keyword", "func_name_keyword"]);
    expect("type_name_token", ["IDENT", "unreserved_keyword", "type_name_keyword"]);
    expect("target_el", ["a_expr AS ColLabelOrString", "a_expr IDENT", "a_expr", "ColId SINGLE_COLON a_expr"]);
    functionClasses = "UF";
    const source = files["third_party/libpg_query/include/parser/kwlist.hpp"];
    const entries = [...source.matchAll(/^PG_KEYWORD\("([a-z_0-9]+)",\s*([A-Z_0-9]+),\s*([A-Z_]+)\)$/gmu)];
    const definitions = source.split(/\r?\n/u).filter((line) => /^PG_KEYWORD/u.test(line));
    assert.equal(entries.length, definitions.length, "Unfamiliar generated keyword record");
    const expected = names.map((name) => [
      name,
      groups.get("R").has(name)
        ? "RESERVED_KEYWORD"
        : groups.get("T").has(name) || groups.get("F").has(name)
          ? "TYPE_FUNC_NAME_KEYWORD"
          : groups.get("C").has(name)
            ? "COL_NAME_KEYWORD"
            : "UNRESERVED_KEYWORD",
    ]);
    assert.deepEqual(
      entries.map((match) => [match[1], match[3]]),
      expected,
      "Lists and shipped lexer disagree",
    );
  } else {
    bareLabels = sorted(list("bare_label"));
    for (const name of bareLabels)
      assert.ok(groups.get("U").has(name) || groups.get("C").has(name), "Invalid bare-label permission");
    const helper = files["src/parser/peg/keyword_helper/default_keyword_maps.cpp"];
    assert.match(helper, /case SuggestionState::SUGGEST_BARE_LABEL:\s*return KEYWORD_BARE_LABEL;/u);
    assert.match(helper, /case SuggestionState::SUGGEST_TYPE_NAME:\s*return KEYWORD_UNRESERVED \| KEYWORD_TYPE_NAME;/u);
    assert.match(
      helper,
      /case SuggestionState::SUGGEST_TABLE_FUNCTION_NAME:\s*return KEYWORD_UNRESERVED \| KEYWORD_TYPE_FUNC;/u,
    );
    assert.match(helper, /default:\s*return KEYWORD_UNRESERVED \| KEYWORD_COL_NAME;/u);
    functionClasses = "UFT";
    const source = files["src/parser/peg/keyword_map.cpp"];
    const records = [...source.matchAll(/^\s*([a-z_]+)_keyword_map\.insert\("([a-z_0-9]+)"\);$/gmu)];
    assert.equal(records.length, source.split(/\r?\n/u).filter((line) => line.includes(".insert(")).length);
    for (const [map, expected] of [
      ["reserved", groups.get("R")],
      ["unreserved", groups.get("U")],
      ["colname", groups.get("C")],
      ["typefunc", new Set([...groups.get("F"), ...groups.get("T")])],
      ["typename", groups.get("T")],
      ["bare_label", new Set(bareLabels)],
    ])
      assert.deepEqual(
        sorted(records.filter((record) => record[1] === map).map((record) => record[2])),
        sorted(expected),
      );
    assert.ok(
      records.every((record) =>
        ["reserved", "unreserved", "colname", "typefunc", "typename", "bare_label"].includes(record[1]),
      ),
    );
  }
  const words = names.map((name) => {
    const membership = classes
      .filter(([key]) => groups.get(key).has(name))
      .map(([key]) => key)
      .join("");
    const categories = [];
    if (membership.includes("R")) categories.push("reserved");
    if (membership.includes("U")) categories.push("unreserved");
    if (membership.includes("F") || membership.includes("T")) categories.push("type_function");
    if (membership.includes("C") && (parser === "peg" || categories.length === 0)) categories.push("column_name");
    return [name, membership, categories];
  });
  return { words, bareLabels, identifierClasses: "UC", functionClasses, typeClasses: "UT" };
}
