import { mySqlKeywordUpper } from "../keyword-case.js";
import { MySqlKeywordFlags as Flags } from "./flags.js";
import type { MySqlKeyword, MySqlKeywordDeclaration, MySqlVocabulary } from "./types.js";

export function createMySqlVocabulary(
  common: readonly MySqlKeywordDeclaration[],
  local: readonly MySqlKeywordDeclaration[],
): MySqlVocabulary {
  const declarations: MySqlKeywordDeclaration[] = JSON.parse(JSON.stringify([...common, ...local]));
  declarations.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (new Set(declarations.map(([name]) => name)).size !== declarations.length)
    throw new TypeError("Duplicate MySQL keyword declaration");
  declarations.forEach(Object.freeze);
  Object.freeze(declarations);
  return Object.freeze({
    declarations,
    forMode(sqlMode = "") {
      const ignoreSpace = sqlMode.split(",").some((mode) => mode.trim() === "IGNORE_SPACE" || mode.trim() === "ANSI");
      const index = new Map<string, MySqlKeyword>();
      for (const [name, flags] of declarations) {
        if (!Number.isSafeInteger(flags) || flags < 0 || flags > 127)
          throw new TypeError("Invalid MySQL keyword flags");
        const group = flags & Flags.specialFunction ? "function" : flags & Flags.hintable ? "hintable" : "keyword";
        index.set(
          name,
          Object.freeze({
            name,
            group,
            reserved: group !== "function" && !!(flags & Flags.reserved),
            functionReserved: !!(flags & Flags.reserved),
            functionHead: !!(flags & Flags.functionHead),
            bareFunction: !!(flags & Flags.bareFunction),
            ordinaryFunction: !!(flags & Flags.ordinaryFunction),
            infix: !!(flags & Flags.infix),
          }),
        );
      }
      return Object.freeze(
        Object.assign(
          (word: string) => (/^[A-Za-z_0-9]+$/u.test(word) ? index.get(mySqlKeywordUpper(word)) : undefined),
          { ignoreSpace },
        ),
      );
    },
  });
}
