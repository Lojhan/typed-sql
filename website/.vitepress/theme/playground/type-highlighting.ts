import { typescriptLanguage } from "@codemirror/lang-javascript";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { PlaygroundDialect } from "./playground.js";

export interface TypeScriptToken {
  readonly text: string;
  readonly className: string;
}

export function highlightTypeScript(source: string): readonly TypeScriptToken[] {
  return highlightSource(source, "typescript");
}

export function highlightSource(
  source: string,
  language: "typescript" | "sql",
  dialect: PlaygroundDialect = "postgres",
): readonly TypeScriptToken[] {
  const tokens: TypeScriptToken[] = [];
  let cursor = 0;
  const sqlDialect = dialect === "mysql" ? MySQL : dialect === "sqlite" ? SQLite : PostgreSQL;
  const parser = language === "sql" ? sqlDialect.language.parser : typescriptLanguage.parser;
  highlightTree(parser.parse(source), classHighlighter, (from, to, className) => {
    if (from > cursor) tokens.push({ text: source.slice(cursor, from), className: "" });
    tokens.push({ text: source.slice(from, to), className });
    cursor = to;
  });
  if (cursor < source.length) tokens.push({ text: source.slice(cursor), className: "" });
  return tokens;
}

export function renderTypeScript(parent: HTMLElement, source: string): void {
  parent.classList.add("ts-type-code");
  for (const token of highlightTypeScript(source)) {
    const span = document.createElement("span");
    span.className = token.className;
    span.textContent = token.text;
    parent.append(span);
  }
}
