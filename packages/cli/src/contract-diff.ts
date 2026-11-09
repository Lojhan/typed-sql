import {
  canonicalContractData,
  createQueryContractIndex,
  type ProjectCatalogClosure,
  parseProjectCatalogClosure,
  parseQueryContract,
  type QueryContract,
} from "@typed-sql/analysis";

function changes<Value extends Record<string, unknown>>(before: Map<string, Value[]>, after: Map<string, Value[]>) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((identity) => {
    const sorted = (values: Value[]) =>
      [...values].sort((left, right) => {
        const a = canonicalContractData(left),
          b = canonicalContractData(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    const old = sorted(before.get(identity) ?? []),
      next = sorted(after.get(identity) ?? []);
    if (canonicalContractData(old) === canonicalContractData(next)) return [];
    const facets = [...new Set([...old, ...next].flatMap((value) => Object.keys(value)))]
      .sort()
      .filter(
        (facet) =>
          canonicalContractData(old.map((value) => value[facet] ?? null)) !==
          canonicalContractData(next.map((value) => value[facet] ?? null)),
      );
    return [
      {
        identity,
        kind: !old.length ? ("added" as const) : !next.length ? ("removed" as const) : ("changed" as const),
        facets,
        before: old,
        after: next,
      },
    ];
  });
}
function queryGroups(contracts: readonly QueryContract[]) {
  createQueryContractIndex(contracts);
  const groups = new Map<string, ReturnType<typeof semantic>[]>();
  const seen = new Set<string>();
  function semantic(contract: QueryContract) {
    const { digest: _digest, columnSpans: _spans, valuePlan, ...facts } = contract;
    return {
      ...facts,
      columns: valuePlan.columns,
      parameters: valuePlan.parameters,
      decodingPolicy: { dialect: valuePlan.dialect, typePolicyHash: valuePlan.typePolicyHash },
    };
  }
  for (const input of contracts) {
    const contract = parseQueryContract(input),
      key = `${contract.context.grammar.id}:${contract.sqlDigest}`;
    if (seen.has(contract.digest)) continue;
    seen.add(contract.digest);
    groups.set(key, [...(groups.get(key) ?? []), semantic(contract)]);
  }
  return groups;
}
function declarations(closure?: ProjectCatalogClosure) {
  const groups = new Map<string, Record<string, unknown>[]>();
  if (closure)
    for (const catalog of parseProjectCatalogClosure(closure).catalogs)
      for (const entry of catalog.entries) {
        const key = canonicalContractData([catalog.owner.id, entry.kind, entry.identity]);
        if (groups.has(key)) throw new TypeError("Ambiguous catalog declaration in export diff");
        groups.set(key, [{ owner: catalog.owner, ...entry }]);
      }
  return groups;
}

/** Review evidence only: changes neither qualify contracts nor authorize publication. */
export function buildContractExportDiff(input: {
  readonly before: readonly QueryContract[];
  readonly after: readonly QueryContract[];
  readonly beforeCatalogs?: ProjectCatalogClosure;
  readonly afterCatalogs?: ProjectCatalogClosure;
}) {
  return {
    formatVersion: 1,
    queries: changes(queryGroups(input.before), queryGroups(input.after)),
    declarations: changes(declarations(input.beforeCatalogs), declarations(input.afterCatalogs)),
    unresolvedFacets: input.after.flatMap((contract) => {
      const facets =
        contract.qualification?.comparisons.filter(
          (comparison) =>
            comparison.nativeStatus !== "complete" ||
            comparison.status === "unavailable" ||
            comparison.status === "conflict",
        ) ??
        (contract.nativeEvidence
          ? [
              {
                target: "query",
                index: 0,
                facet: "qualification",
                status: "unavailable",
                reason: "No independent reconciliation record",
              },
            ]
          : []);
      return facets.length ? [{ sqlDigest: contract.sqlDigest, origin: contract.origin, facets }] : [];
    }),
  };
}
