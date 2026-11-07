import { field, nativeType } from "../../model/facets.mjs";
export function sqlserverEntityFacts(category, row) {
  if (category === "keywords") return { spelling: row.name.toUpperCase() };
  if (category === "types")
    return {
      canonical: nativeType(row.name),
      dimensions: {
        maxLength: field(row, "max_length", "integer"),
        precision: field(row, "precision", "integer"),
        scale: field(row, "scale", "integer"),
      },
    };
  if (category === "settings")
    return {
      minimum: field(row, "minimum", "integer"),
      maximum: field(row, "maximum", "integer"),
      dynamic: field(row, "is_dynamic", "boolean"),
    };
  return {};
}
