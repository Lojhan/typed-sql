/** Read ANTLR2 source boundaries. Action bodies remain opaque, losslessly retained source. */
function tokens(source, start = 0, end = source.length) {
  let cursor = start;
  const output = [];
  function next() {
    while (cursor < end) {
      if (/\s/u.test(source[cursor])) cursor++;
      else if (source.startsWith("//", cursor)) {
        while (cursor < end && source[cursor] !== "\n") cursor++;
      } else if (source.startsWith("/*", cursor)) {
        const close = source.indexOf("*/", cursor + 2);
        if (close < 0 || close >= end) throw new TypeError("Unclosed ScriptDOM comment");
        cursor = close + 2;
      } else break;
    }
    if (cursor >= end) return undefined;
    const begin = cursor,
      verbatim = source.startsWith('@"', cursor),
      quote = verbatim ? '"' : source[cursor];
    if (quote === '"' || quote === "'") {
      cursor += verbatim ? 2 : 1;
      let closed = false;
      while (cursor < end) {
        const character = source[cursor++];
        if (!verbatim && character === "\\") cursor++;
        else if (character === quote) {
          if (verbatim && source[cursor] === '"') cursor++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed || cursor > end) throw new TypeError("Unclosed ScriptDOM string");
      return { type: "string", value: source.slice(begin, cursor), start: begin, end: cursor };
    }
    const opening = source[cursor],
      closing = { "{": "}", "[": "]", "(": ")" }[opening];
    if (closing) {
      cursor++;
      while (true) {
        if (cursor >= end) throw new TypeError("Unclosed ScriptDOM group");
        const child = next();
        if (!child) throw new TypeError("Unclosed ScriptDOM group");
        if (child.value === closing) break;
        if (["}", "]", ")"].includes(child.value)) throw new TypeError("Mismatched ScriptDOM group");
      }
      return { type: "group", value: opening, start: begin, end: cursor };
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/u.exec(source.slice(cursor));
    if (word) {
      cursor += word[0].length;
      return { type: "word", value: word[0], start: begin, end: cursor };
    }
    cursor++;
    return { type: "symbol", value: source[begin], start: begin, end: cursor };
  }
  while (cursor < end) {
    const token = next();
    if (token) {
      if (["}", "]", ")"].includes(token.value)) throw new TypeError("Unexpected ScriptDOM closing group");
      output.push(token);
    }
  }
  return output;
}

const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;
function declarations(source, group) {
  const input = tokens(source, group.start + 1, group.end - 1),
    output = [];
  let index = 0;
  while (index < input.length) {
    const symbol = input[index++];
    if (symbol.type !== "word") throw new TypeError("Unsupported ScriptDOM token declaration");
    let literal = null;
    if (input[index]?.value === "=") {
      index++;
      const value = input[index++];
      if (value?.type !== "string" || !value.value.startsWith('"'))
        throw new TypeError("Unsupported ScriptDOM literal declaration");
      literal = JSON.parse(value.value);
      if (typeof literal !== "string" || !literal) throw new TypeError("Empty ScriptDOM token literal");
    }
    if (input[index++]?.value !== ";") throw new TypeError("Unterminated ScriptDOM token declaration");
    output.push({ symbol: symbol.value, literal, line: lineAt(source, symbol.start) });
  }
  if (!output.length || new Set(output.map(({ symbol }) => symbol)).size !== output.length)
    throw new TypeError("Empty or duplicate ScriptDOM token declarations");
  return output;
}

/** Enumerate every parser/lexer production; this does not interpret C# actions or SQL semantics. */
export function parseGrammar(source) {
  const input = tokens(source),
    classes = [],
    symbols = [],
    productions = [];
  let index = 0,
    section;
  while (index < input.length) {
    const token = input[index++];
    if (token.type === "group" && token.value === "{") continue;
    if (token.value === "exception") {
      const production = productions.at(-1);
      if (!production || production.section !== section) throw new TypeError("Orphan ScriptDOM exception handler");
      if (input[index]?.type === "group" && input[index].value === "[") index++;
      let count = 0;
      while (input[index]?.value === "catch") {
        const start = input[index++].start,
          parameter = input[index++],
          action = input[index++];
        if (parameter?.type !== "group" || parameter.value !== "[" || action?.type !== "group" || action.value !== "{")
          throw new TypeError("Unsupported ScriptDOM exception handler");
        production.handlers.push({ start, end: action.end, line: lineAt(source, start) });
        production.end = action.end;
        count++;
      }
      if (!count) throw new TypeError("Empty ScriptDOM exception handler");
      continue;
    }
    if (["options", "header", "tokens"].includes(token.value)) {
      const group = input[index++];
      if (group?.type !== "group" || group.value !== "{") throw new TypeError("Missing ScriptDOM metadata block");
      if (token.value === "tokens") symbols.push(...declarations(source, group));
      continue;
    }
    if (token.value === "class") {
      const name = input[index++],
        extend = input[index++],
        base = input[index++];
      if (name?.type !== "word" || extend?.value !== "extends" || !["Parser", "Lexer"].includes(base?.value))
        throw new TypeError("Unsupported ScriptDOM grammar class");
      if (input[index]?.type === "group" && input[index].value === "(") index++;
      if (input[index++]?.value !== ";") throw new TypeError("Unterminated ScriptDOM grammar class");
      section = base.value === "Parser" ? "parser" : "lexer";
      classes.push({ name: name.value, section, line: lineAt(source, token.start) });
      continue;
    }
    let visibility = "default",
      name = token;
    if (["protected", "public", "private"].includes(token.value)) {
      visibility = token.value;
      name = input[index++];
    }
    if (!section || name?.type !== "word")
      throw new TypeError(`Unsupported ScriptDOM top-level input at ${token.start}`);
    if (input[index]?.value === "!") index++;
    if (input[index]?.type === "group" && input[index].value === "[") index++;
    if (input[index]?.value === "returns") {
      index++;
      if (input[index]?.type !== "group" || input[index].value !== "[")
        throw new TypeError(`Unsupported ScriptDOM return declaration: ${name.value}`);
      index++;
    }
    if (input[index]?.value === "options") {
      index++;
      if (input[index]?.type !== "group" || input[index].value !== "{")
        throw new TypeError(`Unsupported ScriptDOM production options: ${name.value}`);
      index++;
    }
    if (input[index]?.type === "group" && input[index].value === "{") index++;
    const colon = input[index++];
    if (colon?.value !== ":")
      throw new TypeError(`Unsupported ScriptDOM production header: ${name.value} at ${token.start}`);
    const bodyStart = colon.end,
      bodyIndex = index;
    while (index < input.length && input[index].value !== ";") index++;
    const semicolon = input[index++];
    if (!semicolon) throw new TypeError(`Unterminated ScriptDOM production: ${name.value}`);
    let literal = null;
    if (section === "lexer" && index - bodyIndex === 2 && input[bodyIndex].type === "string") {
      const value = input[bodyIndex].value;
      if (value.startsWith('"')) literal = JSON.parse(value);
      else if (!value.includes("\\")) literal = value.slice(1, -1);
    }
    productions.push({
      name: name.value,
      section,
      visibility,
      start: token.start,
      end: semicolon.end,
      bodyStart,
      bodyEnd: semicolon.start,
      line: lineAt(source, token.start),
      literal,
      handlers: [],
    });
  }
  if (!classes.length || !productions.length) throw new TypeError("Empty ScriptDOM grammar inventory");
  const keys = new Set();
  for (const { section, name, line } of productions) {
    const key = `${section}/${name}`;
    if (keys.has(key)) throw new TypeError(`Duplicate ScriptDOM grammar production: ${key} at ${line}`);
    keys.add(key);
  }
  if (new Set(symbols.map(({ symbol }) => symbol)).size !== symbols.length)
    throw new TypeError("Duplicate ScriptDOM grammar token");
  return { classes, symbols, productions };
}
