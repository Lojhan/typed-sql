/**
 * Preserve the union and membership of profile-specific facts, alongside shared generation inputs.
 * @param {ReturnType<typeof import('./schema.mjs').parseCatalog>} catalog
 */
export function groupCatalog(catalog) {
  const groups = new Map();
  for (const [id, profile] of Object.entries(catalog.profiles)) {
    const key = `${profile.grammar}/${profile.band}`;
    const group = groups.get(key) ?? { grammar: profile.grammar, band: profile.band, profiles: [], categories: {} };
    group.profiles.push({ id, profile });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.profiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const categories = [...new Set(group.profiles.flatMap(({ profile }) => Object.keys(profile.categories)))].sort();
    for (const name of categories) {
      const membership = new Map(),
        unavailable = [];
      for (const { id, profile } of group.profiles) {
        const category = profile.categories[name];
        if (!category || category.status === "unavailable") {
          unavailable.push({ profile: id, reason: category?.reason ?? "Category not declared by this profile" });
          continue;
        }
        for (const entity of new Set(category.entries.map((entry) => entry.entity))) {
          const profiles = membership.get(entity) ?? [];
          profiles.push(id);
          membership.set(entity, profiles);
        }
      }
      const common = [],
        variants = [];
      for (const [id, profiles] of [...membership].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const fact = { id, entity: catalog.entities[id], profiles };
        (profiles.length === group.profiles.length ? common : variants).push(fact);
      }
      group.categories[name] = { common, variants, unavailable };
    }
  }
  return [...groups.values()].sort((a, b) =>
    `${a.grammar}/${a.band}`.localeCompare(`${b.grammar}/${b.band}`, "en", { numeric: true }),
  );
}
