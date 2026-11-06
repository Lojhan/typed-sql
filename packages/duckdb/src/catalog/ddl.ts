import { duckDBAsciiFold } from "../native-types.js";
import { tokenize } from "../parser/tokenizer.js";
export interface DuckDBGeneratedColumnEvidence {
  readonly generated: boolean;
  readonly expression?: string;
}
/** Read canonical engine-owned CREATE TABLE DDL; expression text is evidence, never executed. */
export function duckDBGeneratedColumns(sql: string): ReadonlyMap<string, DuckDBGeneratedColumnEvidence> {
  const tokens = tokenize(sql);
  let index = 0;
  const accept = (value: string) => {
    const token = tokens[index];
    if (token?.kind === "word" && token.value.toUpperCase() === value) {
      index++;
      return true;
    }
    return false;
  };
  if (!accept("CREATE")) throw new TypeError("DuckDB catalog did not provide canonical table DDL");
  accept("TEMP") || accept("TEMPORARY");
  if (!accept("TABLE")) throw new TypeError("DuckDB catalog DDL is not CREATE TABLE");
  if (accept("IF")) {
    if (!accept("NOT") || !accept("EXISTS")) throw new TypeError("Invalid DuckDB catalog table declaration");
  }
  while (tokens[index] && tokens[index]!.text !== "(" && tokens[index]!.kind !== "eof") index++;
  if (tokens[index++]?.text !== "(") throw new TypeError("DuckDB catalog table column list is missing");
  const result = new Map<string, DuckDBGeneratedColumnEvidence>();
  const stack = ["("];
  const closeToOpen: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
  let depth = 1,
    start = index;
  const column = (end: number) => {
    const segment = tokens.slice(start, end),
      first = segment[0];
    if (!first) throw new TypeError("Empty DuckDB catalog column declaration");
    if (
      first.kind === "word" &&
      ["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"].includes(first.value.toUpperCase())
    )
      return;
    if (first.kind !== "word" && first.kind !== "quoted") throw new TypeError("Invalid DuckDB catalog column name");
    const name = duckDBAsciiFold(first.value);
    if (result.has(name)) throw new TypeError("Duplicate DuckDB catalog column name");
    let nested = 0,
      evidence: DuckDBGeneratedColumnEvidence = { generated: false };
    for (let i = 1; i < segment.length; i++) {
      const token = segment[i]!;
      if (["(", "[", "{"].includes(token.text)) nested++;
      else if ([")", "]", "}"].includes(token.text)) nested--;
      if (
        nested === 0 &&
        token.kind === "word" &&
        token.value.toUpperCase() === "GENERATED" &&
        segment[i + 1]?.value.toUpperCase() === "ALWAYS" &&
        segment[i + 2]?.value.toUpperCase() === "AS"
      ) {
        if (segment[i + 3]?.text !== "(") throw new TypeError("DuckDB generated expression is missing");
        let expressionDepth = 1,
          j = i + 4;
        for (; j < segment.length && expressionDepth; j++) {
          if (segment[j]!.text === "(") expressionDepth++;
          else if (segment[j]!.text === ")") expressionDepth--;
        }
        if (expressionDepth) throw new TypeError("Unbalanced DuckDB generated expression");
        evidence = { generated: true, expression: sql.slice(segment[i + 3]!.range.start, segment[j - 1]!.range.end) };
        break;
      }
    }
    result.set(name, evidence);
  };
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (["(", "[", "{"].includes(token.text)) {
      stack.push(token.text);
      if (++depth > 128) throw new TypeError("DuckDB catalog DDL nesting limit");
    } else if ([")", "]", "}"].includes(token.text)) {
      if (stack.pop() !== closeToOpen[token.text]) throw new TypeError("Mismatched DuckDB catalog DDL delimiters");
      if (--depth === 0) {
        column(index);
        index++;
        break;
      }
    } else if (token.text === "," && depth === 1) {
      column(index);
      start = index + 1;
    }
  }
  if (depth !== 0 || !result.size) throw new TypeError("Incomplete DuckDB catalog table DDL");
  if (tokens[index]?.text === ";") index++;
  if (tokens[index]?.kind !== "eof") throw new TypeError("Unexpected DuckDB catalog DDL suffix");
  return result;
}
