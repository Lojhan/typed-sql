import { expandTarget, validateCorpus } from "../../../../scripts/catalog-generation/corpus.mjs";
import { createCatalog } from "../model/build.mjs";
import { hash } from "../model/canonical.mjs";
import { groupCatalog } from "../model/groups.mjs";
import { normalizerRevision } from "../provenance/revision.mjs";

/** Migration adapter only. The normalized model and registry do not depend on the legacy corpus. */
export function importLegacyCorpus(corpus, registry, options) {
  validateCorpus(corpus, registry);
  const inputDigest = hash(corpus);
  const captures = Object.values(corpus.targets).map((entry) => {
    const capture = expandTarget(corpus, entry, registry);
    return { grammar: capture.dialect, target: capture.target, categories: capture.categories };
  });
  return createCatalog(captures, registry, {
    ...options,
    inputDigest,
    sourceLocation: `urn:typed-sql:legacy-corpus:${inputDigest}`,
  });
}

/** Compatibility projection for existing emitters; every row comes through the validated model. */
export function legacyGenerationInput(corpus, registry, requiredCategories) {
  const catalog = importLegacyCorpus(corpus, registry, { requiredCategories, normalizerDigest: normalizerRevision() });
  const groups = groupCatalog(catalog).map((group) => ({
    dialect: group.grammar,
    version: group.band,
    contexts: group.profiles
      .map(({ profile }) => {
        const id = hash({ dialect: profile.grammar, target: profile.target });
        return { id, capture: expandTarget(corpus, corpus.targets[id], registry) };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    categories: Object.fromEntries(
      Object.entries(group.categories).map(([name, category]) => [
        name,
        category.unavailable.length
          ? { status: "unavailable", reasons: [...new Set(category.unavailable.map((entry) => entry.reason))] }
          : {
              status: "observed",
              rows: category.common.map((entry) => entry.entity.native),
              excludedContextRows: category.variants.length,
              variants: category.variants.map((entry) => ({ native: entry.entity.native, profiles: entry.profiles })),
            },
      ]),
    ),
  }));
  return { catalog, groups };
}
