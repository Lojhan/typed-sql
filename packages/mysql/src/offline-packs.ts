import { createMySqlDialect } from "./analysis-factory.js";
import { routineSeries } from "./catalog/generated/availability.js";
import { createMySqlCatalogProvider, type MySqlCatalogProvider } from "./catalog/provider.js";
import type { MySqlCatalogRoutineFamily } from "./catalog/types.js";
import type { MySqlProfileOptions } from "./profile.js";

export interface MySqlOfflinePack {
  readonly id: string;
  readonly series: string;
  readonly sourceRevision: string;
}
export interface MySqlCoreOptions extends MySqlProfileOptions {
  readonly packs?: readonly MySqlOfflinePack[];
}
const owners = new WeakMap<MySqlOfflinePack, readonly MySqlCatalogRoutineFamily[]>();
/** Internal registration belongs to installed grammar modules, not deserialized project metadata. */
export function registerMySqlCompatibilityPack(
  series: string,
  sourceRevision: string,
  routines: readonly MySqlCatalogRoutineFamily[],
): MySqlOfflinePack {
  const pack = Object.freeze({ id: "mysql-compatibility", series, sourceRevision });
  owners.set(pack, routines);
  return pack;
}
export function createMySqlCoreDialect(core: MySqlCatalogProvider, series: string, options: MySqlCoreOptions = {}) {
  let catalog = core;
  const seen = new Set<string>();
  for (const pack of options.packs ?? []) {
    const additional = owners.get(pack);
    if (!additional) throw new TypeError("MySQL offline packs must come from an installed grammar pack export");
    if (pack.series !== series) throw new TypeError(`MySQL offline pack requires series ${pack.series}`);
    if (seen.has(pack.id)) throw new TypeError(`Duplicate MySQL offline pack ${pack.id}`);
    seen.add(pack.id);
    const base = catalog.catalog(series)!;
    const families = new Set(base.routines.map((family) => family.name));
    const names = new Set(base.routines.flatMap((family) => family.routines));
    for (const family of additional)
      if (families.has(family.name) || family.routines.some((name) => names.has(name)))
        throw new TypeError(`Overlapping MySQL offline family ${family.name}`);
    catalog = createMySqlCatalogProvider(
      [
        {
          ...base,
          revision: pack.sourceRevision,
          routines: [...base.routines, ...additional].sort((a, b) => a.name.localeCompare(b.name)),
        },
      ],
      { routineSeries },
    );
  }
  return createMySqlDialect(catalog, options, series);
}
