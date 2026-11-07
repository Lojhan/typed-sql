import { keywordInventory } from "./facts.mjs";

/** Associate parser-source profiles with exact captured compatibility settings, not engine majors. */
export function sourceCoverage(facts, groups) {
  const contexts = {},
    profiles = {},
    used = new Set();
  for (const group of groups)
    for (const { id, capture } of group.contexts) {
      const compatibilityLevel = capture.target.settings?.compatibilityLevel,
        version = String(compatibilityLevel),
        source = facts.versions[version],
        target = source?.targets.find((target) => target.id === id);
      if (!target || target.version !== capture.target.version || target.compatibilityLevel !== compatibilityLevel)
        throw new TypeError(`Missing or stale ScriptDOM/native profile association: ${id}`);
      if (used.has(id)) throw new TypeError("Duplicate SQL Server source/native context");
      used.add(id);
      contexts[id] = {
        engineVersion: target.version,
        compatibilityLevel,
        parserVersion: version,
        revision: source.revision,
      };
    }
  for (const [version, source] of Object.entries(facts.versions)) {
    if (source.targets.some(({ id }) => !used.has(id))) throw new TypeError("Stale ScriptDOM native target");
    profiles[version] = {
      revision: source.revision,
      scope: source.scope,
      classes: source.grammar.classes,
      keywordLiterals: keywordInventory(source),
      productions: {
        parser: source.grammar.productions.filter(({ section }) => section === "parser").length,
        lexer: source.grammar.productions.filter(({ section }) => section === "lexer").length,
      },
      simpleLexerLiterals: source.grammar.productions
        .filter(({ section, literal }) => section === "lexer" && literal !== null)
        .map(({ name, literal, line }) => ({ name, literal, line })),
      hostProductionCoverage: "unqualified; source production names do not prove typed-sql parser support",
      engineSemantics: "unqualified; ScriptDOM is not the SQL Server binder or builtin overload catalog",
    };
  }
  return { formatVersion: 1, grammar: "sqlserver", profiles, contexts };
}
