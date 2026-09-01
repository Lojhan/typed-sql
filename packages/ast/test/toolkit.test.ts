import { describe, it, strict } from "poku";
import {
  definePrecedenceTable,
  defineSqlLexicalProfile,
  mergeSourceRanges,
  SqlToolkitError,
  TokenCursor,
  tokenizeSql,
  walkTree,
} from "../src/toolkit/index.js";

const profile = defineSqlLexicalProfile({
  keywords: new Set(["FROM", "SELECT"]),
  operators: ["=", "=>", "+"],
  identifierQuotes: [
    { open: '"', close: '"', escape: "double-close" },
    { open: "[", close: "]", escape: "none" },
  ],
  stringModes: [
    { prefix: "E", quote: "'", backslashEscapes: true },
    { prefix: "", quote: "'" },
  ],
  parameterModes: [
    { kind: "numbered-question", startAt: 1 },
    { kind: "numbered-dollar", startAt: 1 },
  ],
  nestedBlockComments: true,
});

await describe("grammar-neutral parser toolkit", async () => {
  await it("tokenizes a supplied lexical profile with immutable ranges and longest operators", () => {
    const tokens = tokenizeSql(
      `/* outer /* nested */ */\nSELECT "a""b", [label], E'line\\nnext', 1.25e+2 FROM widgets WHERE value => ?1 AND id = $2`,
      profile,
    );
    strict.strictEqual(tokens[0]?.value, "SELECT");
    strict.deepStrictEqual(tokens[0]?.range, { start: 25, end: 31, line: 2, column: 1 });
    strict.strictEqual(tokens.find((token) => token.kind === "quoted-identifier")?.value, 'a"b');
    strict.strictEqual(tokens.find((token) => token.kind === "string")?.value, "line\nnext");
    strict.deepStrictEqual(
      tokens.filter((token) => token.kind === "parameter").map(({ value }) => value),
      ["1", "2"],
    );
    strict.ok(tokens.some((token) => token.kind === "operator" && token.value === "=>"));
    strict.ok(Object.isFrozen(tokens));
    strict.ok(Object.isFrozen(tokens[0]));
    strict.ok(Object.isFrozen(tokens[0]?.range));
    strict.ok(Object.isFrozen(profile));
    strict.strictEqual("add" in profile.keywords, false);
    strict.strictEqual(profile.keywords.size, 2);
    strict.deepStrictEqual([...profile.keywords.keys()].sort(), ["FROM", "SELECT"]);
    strict.deepStrictEqual([...profile.keywords.values()].sort(), ["FROM", "SELECT"]);
    strict.strictEqual([...profile.keywords.entries()].length, 2);
    strict.deepStrictEqual([...profile.keywords].sort(), ["FROM", "SELECT"]);
    const visitedKeywords: string[] = [];
    profile.keywords.forEach((value, key, set) => {
      strict.strictEqual(value, key);
      strict.strictEqual(set, profile.keywords);
      visitedKeywords.push(value);
    });
    strict.strictEqual(visitedKeywords.length, 2);
    strict.strictEqual(Object.prototype.toString.call(profile.keywords), "[object Set]");
  });

  await it("provides bounded cursor, identifier, list, and error mechanics", () => {
    const cursor = new TokenCursor(tokenizeSql("SELECT (one, two)", profile), { maxDepth: 2 });
    cursor.expect("SELECT");
    const names = cursor.delimited("(", ")", ",", () => cursor.identifier().value);
    strict.deepStrictEqual(names, ["one", "two"]);
    strict.ok(Object.isFrozen(names));
    strict.strictEqual(cursor.expectKind("eof").kind, "eof");

    const nested = new TokenCursor(tokenizeSql("SELECT", profile), { maxDepth: 1 });
    strict.throws(
      () => nested.nested(() => nested.nested(() => undefined)),
      (error: unknown) => error instanceof SqlToolkitError && error.code === "TSQ002",
    );
    strict.throws(() => new TokenCursor([], {}), /terminal eof token/u);
    strict.throws(() => new TokenCursor(tokenizeSql("SELECT", profile), { maxDepth: 0 }), /positive safe integer/u);

    const branches = new TokenCursor(tokenizeSql("SELECT name", profile));
    strict.strictEqual(branches.peek().value, "name");
    strict.strictEqual(branches.matchKind("identifier"), undefined);
    strict.strictEqual(branches.identifier(true).value, "SELECT");
    strict.strictEqual(branches.previous().value, "SELECT");
    strict.strictEqual(branches.matchKind("identifier")?.value, "name");
    strict.strictEqual(branches.advance().kind, "eof");
    strict.throws(() => branches.expect("SELECT"), /Expected SELECT/u);

    const empty = new TokenCursor(tokenizeSql("()", profile));
    strict.deepStrictEqual(
      empty.delimited("(", ")", ",", () => "unused"),
      [],
    );
    const wrongKind = new TokenCursor(tokenizeSql("SELECT", profile));
    strict.throws(() => wrongKind.expectKind("identifier", "name"), /Expected name/u);
    strict.throws(() => wrongKind.identifier(), /Expected identifier/u);
    strict.throws(() => wrongKind.error("explicit"), /explicit/u);
  });

  await it("fails closed for malformed input, invalid profiles, and resource limits", () => {
    for (const operation of [
      () => tokenizeSql("SELECT @", profile),
      () => tokenizeSql("SELECT 'unterminated", profile),
      () => tokenizeSql('SELECT "unterminated', profile),
      () => tokenizeSql("/* unterminated", profile),
      () => tokenizeSql("SELECT ?0", profile),
      () => tokenizeSql("SELECT 1e+", profile),
      () => tokenizeSql("SELECT", profile, { maxSqlLength: 2 }),
      () => tokenizeSql("SELECT one", profile, { maxTokens: 1 }),
    ]) {
      strict.throws(operation, (error: unknown) => error instanceof SqlToolkitError);
    }
    strict.throws(() => defineSqlLexicalProfile({ ...profile, keywords: new Set(["select"]) }), /uppercase strings/u);
    strict.throws(() => defineSqlLexicalProfile({ ...profile, operators: [""] }), /non-empty strings/u);
    strict.throws(() => tokenizeSql("SELECT", profile, { maxTokens: 0 }), /positive safe integer/u);
  });

  await it("offers deterministic precedence, range, and generic tree-walking helpers", () => {
    const precedence = definePrecedenceTable({ OR: 1, AND: 2 });
    strict.strictEqual(precedence.get("AND"), 2);
    strict.strictEqual("set" in precedence, false);
    strict.strictEqual(precedence.size, 2);
    strict.strictEqual(precedence.has("OR"), true);
    strict.deepStrictEqual([...precedence.keys()].sort(), ["AND", "OR"]);
    strict.deepStrictEqual([...precedence.values()].sort(), [1, 2]);
    strict.strictEqual([...precedence.entries()].length, 2);
    strict.strictEqual([...precedence].length, 2);
    const visitedOperators: string[] = [];
    precedence.forEach((value, key, map) => {
      strict.strictEqual(map, precedence);
      visitedOperators.push(`${key}:${value}`);
    });
    strict.deepStrictEqual(visitedOperators, ["OR:1", "AND:2"]);
    strict.strictEqual(Object.prototype.toString.call(precedence), "[object Map]");
    strict.throws(() => definePrecedenceTable({ broken: -1 }), /non-negative safe integer/u);
    strict.deepStrictEqual(
      mergeSourceRanges({ start: 2, end: 4, line: 2, column: 3 }, { start: 8, end: 10, line: 2, column: 9 }),
      { start: 2, end: 10, line: 2, column: 3 },
    );

    interface Node {
      readonly name: string;
      readonly children: readonly Node[];
    }
    const leaf: Node = { name: "leaf", children: [] };
    const root: Node = { name: "root", children: [leaf] };
    const visited: string[] = [];
    walkTree(
      root,
      (node) => node.children,
      (node, parent) => visited.push(`${parent?.name ?? "none"}:${node.name}`),
    );
    strict.deepStrictEqual(visited, ["none:root", "root:leaf"]);
    const cyclic = { name: "cycle", children: [] as Node[] };
    cyclic.children.push(cyclic);
    strict.throws(
      () =>
        walkTree<Node>(
          cyclic,
          (node) => node.children,
          () => undefined,
        ),
      /cyclic nodes/u,
    );
  });

  await it("supports anonymous parameters, trivia, and doubled ordinary strings", () => {
    const anonymous = defineSqlLexicalProfile({
      ...profile,
      parameterModes: [{ kind: "question" }],
    });
    const tokens = tokenizeSql("-- lead\nSELECT 'it''s', ?, ?", anonymous);
    strict.strictEqual(tokens.find((token) => token.kind === "string")?.value, "it's");
    strict.deepStrictEqual(
      tokens.filter((token) => token.kind === "parameter").map(({ value }) => value),
      ["1", "2"],
    );
  });
});
