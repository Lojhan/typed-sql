/** Interpret literal instantiator bounds, following aliases without evaluating vendor C++. */
export function instantiatorBounds(input) {
  const source = input.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, (value) => value.replace(/[^\r\n]/gu, " ")),
    declarations = new Map(),
    specialized = new Set(),
    guardedLines = new Set();
  let depth = 0;
  for (const [index, line] of source.split("\n").entries()) {
    if (/^\s*#\s*(?:if|ifdef|ifndef)\b/u.test(line)) depth++;
    if (depth) guardedLines.add(index + 1);
    if (/^\s*#\s*endif\b/u.test(line)) depth--;
    if (depth < 0) throw new TypeError("Unsupported MySQL source condition: unmatched endif");
  }
  if (depth) throw new TypeError("Unclosed MySQL source condition");
  const location = (offset) => source.slice(0, offset).split("\n").length;
  const register = (name, declaration) => {
    if (declarations.has(name)) throw new TypeError(`Duplicate MySQL instantiator declaration: ${name}`);
    declarations.set(name, declaration);
  };
  for (const match of source.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*([<{])/gu)) {
    if (match[2] === "<") {
      specialized.add(match[1]);
      continue;
    }
    const start = match.index + match[0].length;
    let nesting = 1,
      end = start;
    const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/gu;
    tokens.lastIndex = start;
    for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
      if (token[0] === "{") nesting++;
      else if (token[0] === "}" && --nesting === 0) {
        end = token.index;
        break;
      }
    }
    if (end === start) throw new TypeError(`Unclosed MySQL class: ${match[1]}`);
    const body = source.slice(start, end),
      line = location(match.index);
    if (guardedLines.has(line) || /^\s*#/mu.test(body)) continue;
    // Bounds must be unconditional public data members, preceding every method body.
    const members = body.slice(0, body.indexOf("{") < 0 ? body.length : body.indexOf("{"));
    const values = [
      ...members.matchAll(
        /\bstatic\s+(?:const\s+uint|constexpr\s+int)\s+(Min_argcount|Max_argcount)\s*=\s*(\d+|MAX_ARGLIST_SIZE)\s*;/gu,
      ),
    ];
    if (values.length !== 2 || new Set(values.map((value) => value[1])).size !== 2) continue;
    if (!/^\s*public\s*:/u.test(members) || /\b(?:private|protected)\s*:/u.test(members)) continue;
    register(match[1], {
      kind: "class",
      line,
      minimum: values.find((value) => value[1] === "Min_argcount")[2],
      maximum: values.find((value) => value[1] === "Max_argcount")[2],
    });
  }
  for (const match of source.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/gu)) {
    const line = location(match.index),
      target = /^([A-Za-z_]\w*)(?:\s*<[^;{}]+>)?$/u.exec(match[2].trim()),
      template = /\btemplate\s*<([^<>]*)>\s*$/u.exec(source.slice(0, match.index));
    if (!target || guardedLines.has(line)) continue;
    if (source.slice(0, match.index).trimEnd().endsWith(">") && !template) continue;
    if (template?.[1].split(/\W+/u).includes(target[1])) continue;
    register(match[1], { kind: "alias", target: target[1], line });
  }
  return (name) => {
    const evidence = [],
      visited = new Set();
    while (!visited.has(name)) {
      visited.add(name);
      if (specialized.has(name)) return undefined;
      const declaration = declarations.get(name);
      if (!declaration) return undefined;
      evidence.push({ symbol: name, line: declaration.line });
      if (declaration.kind === "alias") name = declaration.target;
      else {
        if (!/^\d+$/u.test(declaration.minimum)) return undefined;
        if (/^\d+$/u.test(declaration.maximum) && Number(declaration.maximum) < Number(declaration.minimum))
          throw new TypeError("Invalid MySQL instantiator range");
        return { minimum: declaration.minimum, maximum: declaration.maximum, evidence };
      }
    }
    throw new TypeError("Cyclic MySQL instantiator aliases");
  };
}
