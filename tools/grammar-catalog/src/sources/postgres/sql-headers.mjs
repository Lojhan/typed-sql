/** A bounded lexer for vendor installation headers; bodies remain opaque source evidence. */
export function headerTokens(sql) {
  const tokens = [];
  let cursor = 0;
  const push = (start, kind, value = sql.slice(start, cursor)) => tokens.push({ start, end: cursor, kind, value });
  while (cursor < sql.length) {
    const start = cursor,
      character = sql[cursor];
    if (/\s/u.test(character)) {
      cursor++;
      continue;
    }
    if (sql.startsWith("--", cursor)) {
      const end = sql.indexOf("\n", cursor + 2);
      cursor = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", cursor)) {
      let depth = 1;
      cursor += 2;
      while (cursor < sql.length && depth) {
        if (sql.startsWith("/*", cursor)) {
          depth++;
          cursor += 2;
        } else if (sql.startsWith("*/", cursor)) {
          depth--;
          cursor += 2;
        } else cursor++;
      }
      if (depth) throw new TypeError("Unclosed vendor SQL comment");
      continue;
    }
    const dollar = /^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/u.exec(sql.slice(cursor))?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, cursor + dollar.length);
      if (end < 0) throw new TypeError("Unclosed vendor SQL dollar string");
      cursor = end + dollar.length;
      push(start, "string");
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const escaped =
        quote === "'" &&
        tokens.at(-1)?.kind === "word" &&
        tokens.at(-1)?.value === "e" &&
        tokens.at(-1)?.end === cursor;
      cursor++;
      let value = "",
        closed = false;
      while (cursor < sql.length) {
        const item = sql[cursor++];
        if (escaped && item === "\\") {
          if (cursor >= sql.length) throw new TypeError("Unclosed vendor SQL escape string");
          value += item + sql[cursor++];
        } else if (item === quote) {
          if (sql[cursor] === quote) {
            cursor++;
            value += quote;
          } else {
            closed = true;
            break;
          }
        } else value += item;
      }
      if (!closed) throw new TypeError("Unclosed vendor SQL quoted token");
      push(start, quote === '"' ? "quoted" : "string", value);
      continue;
    }
    const word = /^[a-zA-Z_][a-zA-Z_0-9$]*/u.exec(sql.slice(cursor))?.[0];
    if (word) {
      cursor += word.length;
      push(
        start,
        "word",
        word.replace(/[A-Z]/gu, (value) => value.toLowerCase()),
      );
      continue;
    }
    cursor++;
    push(start, "symbol");
  }
  return tokens;
}

const word = (token, value) => token?.kind === "word" && token.value === value;
function parts(tokens, start) {
  if (tokens[start]?.value !== "(") throw new TypeError("Expected vendor SQL argument list");
  const result = [];
  let depth = 0,
    first = start + 1;
  for (let index = first; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "symbol" && ["(", "["].includes(token.value)) depth++;
    if (token.kind === "symbol" && [")", "]"].includes(token.value)) {
      if (token.value === ")" && depth === 0) {
        if (index > first) result.push(tokens.slice(first, index));
        else if (result.length) throw new TypeError("Empty vendor SQL argument");
        return { parts: result, end: index + 1 };
      }
      if (--depth < 0) throw new TypeError("Unbalanced vendor SQL argument");
    }
    if (token.kind === "symbol" && token.value === "," && depth === 0) {
      if (index === first) throw new TypeError("Empty vendor SQL argument");
      result.push(tokens.slice(first, index));
      first = index + 1;
    }
  }
  throw new TypeError("Unclosed vendor SQL argument list");
}

function declaredType(tokens, typeNames) {
  if (
    !tokens.length ||
    tokens.some((token) => !["word", "quoted"].includes(token.kind) && !["[", "]", "."].includes(token.value))
  )
    return undefined;
  let name = tokens
    .map(({ value }) => value)
    .join(" ")
    .replace(/\s*\.\s*/gu, ".")
    .replace(/\s*\[\s*\]/gu, "[]");
  if (name.startsWith("pg_catalog.")) name = name.slice("pg_catalog.".length);
  return typeNames.get(name) ?? (new Set(typeNames.values()).has(name) ? name : undefined);
}

function parameter(tokens, sql, typeNames, forcedMode) {
  let depth = 0,
    defaultAt = -1;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "symbol" && ["(", "["].includes(token.value)) depth++;
    if (token.kind === "symbol" && [")", "]"].includes(token.value)) depth--;
    if (depth === 0 && (word(token, "default") || (token.kind === "symbol" && token.value === "="))) {
      defaultAt = index;
      break;
    }
  }
  let declaration = defaultAt < 0 ? tokens : tokens.slice(0, defaultAt);
  let mode = forcedMode ?? "i";
  const modes = { in: "i", out: "o", inout: "b", variadic: "v" };
  if (declaration[0]?.kind === "word" && modes[declaration[0].value]) {
    mode = modes[declaration[0].value];
    declaration = declaration.slice(1);
  }
  let name = null,
    type = declaredType(declaration, typeNames);
  if (!type && ["word", "quoted"].includes(declaration[0]?.kind)) {
    name = declaration[0].value;
    type = declaredType(declaration.slice(1), typeNames);
  }
  if (!type)
    throw new TypeError(`Unqualified vendor SQL argument type: ${sql.slice(tokens[0].start, tokens.at(-1).end)}`);
  if (defaultAt >= 0 && defaultAt === tokens.length - 1) throw new TypeError("Missing vendor SQL default expression");
  return {
    name,
    type,
    mode,
    default: defaultAt < 0 ? null : sql.slice(tokens[defaultAt + 1].start, tokens.at(-1).end),
  };
}

/** Extract every CREATE FUNCTION header, retaining failures rather than skipping unsupported syntax. */
export function installationHeaders(sql, typeNames) {
  const tokens = headerTokens(sql),
    headers = [],
    gaps = [];
  for (let cursor = 0; cursor < tokens.length; cursor++) {
    if (!word(tokens[cursor], "create")) continue;
    let index = cursor + 1;
    if (word(tokens[index], "or") && word(tokens[index + 1], "replace")) index += 2;
    if (!word(tokens[index], "function")) continue;
    try {
      index++;
      const first = tokens[index++];
      if (!["word", "quoted"].includes(first?.kind)) throw new TypeError("Missing vendor SQL routine name");
      let namespace = "pg_catalog",
        name = first.value;
      if (tokens[index]?.value === ".") {
        namespace = name;
        index++;
        name = tokens[index++]?.value;
      }
      const args = parts(tokens, index);
      const parameters = args.parts.map((part) => parameter(part, sql, typeNames));
      let end = args.end;
      if (word(tokens[end], "returns") && word(tokens[end + 1], "table")) {
        const outputs = parts(tokens, end + 2);
        parameters.push(...outputs.parts.map((part) => parameter(part, sql, typeNames, "t")));
        end = outputs.end;
      }
      const inputs = parameters.filter(({ mode }) => ["i", "b", "v"].includes(mode));
      const defaults = inputs.filter(({ default: value }) => value !== null);
      if (
        inputs.some(
          (parameter, index) =>
            parameter.default !== null && inputs.slice(index + 1).some((next) => next.default === null),
        )
      )
        throw new TypeError("Non-trailing vendor SQL defaults");
      headers.push({
        namespace,
        name,
        parameters,
        inputs: inputs.map(({ type }) => type),
        defaults: defaults.length,
        start: tokens[cursor].start,
        end: tokens[end - 1].end,
        sql: sql.slice(tokens[cursor].start, tokens[end - 1].end),
      });
      cursor = end - 1;
    } catch (error) {
      gaps.push({ start: tokens[cursor].start, reason: String(error) });
    }
  }
  return { headers, gaps };
}
