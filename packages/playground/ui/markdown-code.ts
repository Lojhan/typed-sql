import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import sql from "shiki/langs/sql.mjs";
import typescript from "shiki/langs/typescript.mjs";
import dark from "shiki/themes/github-dark.mjs";
import light from "shiki/themes/github-light.mjs";
import type { CodeHighlighterPlugin } from "streamdown";

const languages = ["sql", "typescript", "javascript", "json"];
const aliases: Record<string, string> = { ts: "typescript", js: "javascript" };
const highlighter = createHighlighterCore({
  themes: [light, dark],
  langs: [sql, typescript, javascript, json],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});
/** A bounded grammar set avoids shipping every Shiki language with the local workspace. */
export const code: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => languages,
  getThemes: () => ["github-light", "github-dark"],
  supportsLanguage: (language) => languages.includes(aliases[language] ?? language),
  highlight(options, callback) {
    const lang = aliases[options.language] ?? options.language;
    if (options.code.length > 32_768) return null;
    void highlighter
      .then((highlighter) =>
        callback?.(
          highlighter.codeToTokens(options.code, {
            lang: languages.includes(lang) ? lang : "text",
            themes: { light: "github-light", dark: "github-dark" },
          }),
        ),
      )
      .catch(() => {
        // Streamdown retains readable plain code if highlighting is unavailable.
      });
    return null;
  },
};
