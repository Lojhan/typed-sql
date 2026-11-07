export function sourceCoverage(facts, groups) {
  const profiles = {};
  for (const group of groups)
    for (const { id, capture } of group.contexts) {
      const version = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec(capture.target.version)?.[1],
        source = facts.versions[version];
      if (!source) throw new TypeError(`Missing MySQL source profile: ${capture.target.version}`);
      const actual = capture.categories.keywords;
      if (actual?.status !== "observed") throw new TypeError("Unqualified MySQL native keywords");
      const rows = actual.rows
        .map(({ name, reserved }) => {
          if (![0, 1, false, true, "0", "1"].includes(reserved)) throw new TypeError("Unknown MySQL reserved flag");
          return [name, Number(reserved) === 1];
        })
        .sort(([a], [b]) => a.localeCompare(b));
      const expected = source.keywords
        .map(({ name, reserved }) => [name, reserved])
        .sort(([a], [b]) => a.localeCompare(b));
      if (JSON.stringify(rows) !== JSON.stringify(expected))
        throw new TypeError(`MySQL source/native keywords disagree: ${version}`);
      profiles[id] = {
        version,
        revision: source.revision,
        keywords: { matched: rows.length, scope: "exact native keyword names and reserved flags" },
        functions: {
          registrations: source.functions.length,
          macroArityKnown: source.functions.filter(({ arityKnowledge }) => arityKnowledge === "macro").length,
          instantiatorArityKnown: source.functions.filter(({ arityKnowledge }) => arityKnowledge === "instantiator")
            .length,
          conditionalRegistrations: source.functions.filter(({ conditions }) => conditions.length),
          unresolvedFactories: source.functions.filter(
            ({ arityKnowledge }) => arityKnowledge === "specialized-unknown",
          ),
          lexicalFunctionNames: source.lexicalFunctions,
          qualification:
            "registration and partial macro/instantiator arity only; build conditions, formal names/types, defaults, result types, nullability, special syntax and decoding unqualified",
        },
      };
    }
  return { formatVersion: 1, grammar: "mysql", profiles };
}
