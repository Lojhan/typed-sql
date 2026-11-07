import { field, known } from "../../model/facets.mjs";
export function mysqlEntityFacts(category, row) {
  if (category === "keywords") return { spelling: row.name.toUpperCase(), reserved: field(row, "reserved", "boolean") };
  if (category === "collations")
    return {
      characterSet: field(row, "character_set"),
      isDefault:
        typeof row.is_default === "string" && ["", "Yes"].includes(row.is_default)
          ? known(row.is_default === "Yes")
          : field(row, "is_default", "boolean"),
    };
  // HELP topics include type-related syntax (e.g. AUTO_INCREMENT), not just type identities.
  return {};
}
