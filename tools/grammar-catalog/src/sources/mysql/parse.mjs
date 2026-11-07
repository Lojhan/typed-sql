/** Preserve offsets while removing C comments; strings and character literals remain opaque. */
export const uncomment = (body) =>
  body.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, (value) =>
    value.startsWith("/") ? value.replace(/[^\r\n]/g, " ") : value,
  );

function table(body, name) {
  const source = uncomment(body);
  const match = new RegExp(`\\b${name}\\s*\\[\\s*\\]\\s*=\\s*\\{`, "u").exec(source);
  if (!match) throw new TypeError(`Missing MySQL source table: ${name}`);
  const rows = [];
  const conditions = [];
  function prefix(value) {
    for (const line of value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && line !== ",")) {
      if (/^#\s*(?:if|ifdef|ifndef)\b/u.test(line)) conditions.push({ open: line, branches: [], ended: false });
      else if (/^#\s*(?:else|elif)\b/u.test(line) && conditions.length) {
        const frame = conditions.at(-1);
        if (frame.ended) throw new TypeError("Duplicate MySQL source condition branch");
        frame.branches.push(line);
        frame.ended = /^#\s*else\b/u.test(line);
      } else if (/^#\s*endif\b/u.test(line) && conditions.length) conditions.pop();
      else throw new TypeError(`Unsupported MySQL table input: ${line}`);
    }
  }
  let cursor = match.index + match[0].length,
    start = cursor,
    depth = 0;
  while (cursor < source.length) {
    const character = source[cursor++];
    if (character === '"' || character === "'") {
      let closed = false;
      while (cursor < source.length) {
        const next = source[cursor++];
        if (next === "\\") cursor++;
        else if (next === character) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new TypeError("Unclosed MySQL table literal");
      continue;
    }
    if (character === "{") {
      if (depth++ === 0) {
        prefix(source.slice(start, cursor - 1));
        start = cursor - 1;
      }
    } else if (character === "}") {
      if (depth === 0) {
        prefix(source.slice(start, cursor - 1));
        if (conditions.length) throw new TypeError("Unclosed MySQL source condition");
        if (!rows.length) throw new TypeError("Empty MySQL source table");
        return rows;
      }
      if (--depth === 0) {
        rows.push({
          text: source.slice(start, cursor),
          line: source.slice(0, start).split("\n").length,
          conditions: conditions.map(({ open, branches }) => [open, ...branches].join(" / ")),
        });
        start = cursor;
      }
    }
  }
  throw new TypeError("Unclosed MySQL source table");
}

/** Mirror the vendor gen_keyword_list.cc classification, retaining lexical functions separately. */
export function keywords(lex, yacc) {
  const tokens = new Map();
  for (const line of uncomment(yacc).split(/\r?\n/u)) {
    if (!/^%token\b/u.test(line)) continue;
    const match = /^%token\s*(?:<([._a-zA-Z0-9]+)>\s*)?([_a-zA-Z0-9]+)\s+(\d+)\b/u.exec(line);
    if (!match || tokens.has(match[2])) throw new TypeError(`Unsupported MySQL token declaration: ${line}`);
    tokens.set(match[2], { code: Number(match[3]), nonReserved: match[1] === "lexer.keyword" });
  }
  if (!tokens.size) throw new TypeError("Missing MySQL grammar token declarations");
  const words = [],
    functions = [],
    symbols = [];
  for (const row of table(lex, "symbols")) {
    if (row.conditions.length) throw new TypeError("Conditional MySQL lexical symbols require qualification");
    const match = /^\{\s*(SYM(?:_FN|_HK|_H)?)\(\s*("(?:\\.|[^"\\])*")\s*,\s*([A-Z_0-9]+)\s*\)\s*\}$/u.exec(row.text);
    if (!match) throw new TypeError(`Unsupported MySQL lexical record at ${row.line}`);
    const name = JSON.parse(match[2]),
      token = match[3],
      group = match[1];
    const metadata = tokens.get(token);
    if (!metadata && group !== "SYM_H") throw new TypeError(`Missing MySQL grammar token: ${token}`);
    symbols.push({ name, token, group, line: row.line });
    if (group === "SYM_FN") functions.push({ name, token, code: metadata.code });
    if (["SYM", "SYM_HK"].includes(group) && /^[A-Za-z]/u.test(name))
      words.push({ name, token, code: metadata.code, reserved: !metadata.nonReserved });
  }
  if (new Set(words.map(({ name }) => name)).size !== words.length) throw new TypeError("Duplicate MySQL keyword");
  return { keywords: words, lexicalFunctions: functions, symbols };
}

/** All records are retained; specialized factories keep explicitly unknown arity. */
export function functions(body) {
  const source = uncomment(body),
    macros = new Map();
  for (const match of source
    .replace(/\\\r?\n/gu, " ")
    .matchAll(/^#define[ \t]+(SQL_[A-Z_]+)\(([^)]*)\)[ \t]+([^\n]*)/gmu))
    macros.set(match[1], {
      parameters: match[2].split(",").map((value) => value.trim()),
      body: match[3].replace(/\\\r?\n/gu, " "),
    });
  const rows = table(body, "func_array").map((entry) => {
    const match = /^\{\s*"([A-Z_0-9]+)"\s*,\s*([\s\S]+)\s*\}$/u.exec(entry.text);
    if (!match) throw new TypeError(`Unsupported MySQL function record at ${entry.line}`);
    const name = match[1],
      builder = match[2].trim();
    let minimum = null,
      maximum = null,
      maximumExpression = null,
      parity = "unknown",
      internal = null,
      arityKnowledge = "specialized-unknown";
    const call = /^(SQL_[A-Z_]+)\(([^()]*)\)$/u.exec(builder),
      macro = call && macros.get(call[1]);
    const supported =
      macro &&
      /^&(?:Function_factory|Internal_function_factory|Odd_argcount_function_factory|Even_argcount_function_factory)<(?:Instantiator|Instantiator_with_thd|List_instantiator|List_instantiator_with_thd)<F,(?:N|MIN)(?:,MAX)?>>::s_singleton$/u.test(
        macro.body.replace(/\s/gu, ""),
      );
    if (supported && ["F,N", "F,MIN,MAX"].includes(macro.parameters.join(","))) {
      const args = call[2].split(",").map((value) => value.trim());
      if (args.length !== macro.parameters.length || !/^\d+$/u.test(args[1]))
        throw new TypeError(`Unsupported MySQL factory arguments: ${name}`);
      minimum = Number(args[1]);
      maximumExpression = args[2] ?? args[1];
      if (/^\d+$/u.test(maximumExpression)) maximum = Number(maximumExpression);
      else if (maximumExpression !== "MAX_ARGLIST_SIZE")
        throw new TypeError(`Unknown MySQL arity expression: ${maximumExpression}`);
      if (maximum !== null && maximum < minimum) throw new TypeError("Invalid MySQL factory range");
      parity = macro.body.includes("Odd_argcount_function_factory")
        ? "odd"
        : macro.body.includes("Even_argcount_function_factory")
          ? "even"
          : "any";
      internal = macro.body.includes("Internal_function_factory");
      arityKnowledge = "macro";
    }
    return {
      name,
      builder,
      line: entry.line,
      conditions: entry.conditions,
      minimum,
      maximum,
      maximumExpression,
      parity,
      internal,
      arityKnowledge,
    };
  });
  if (new Set(rows.map(({ name }) => name)).size !== rows.length)
    throw new TypeError("Duplicate MySQL function registration");
  return rows;
}
