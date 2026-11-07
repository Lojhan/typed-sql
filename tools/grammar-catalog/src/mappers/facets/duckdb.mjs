import { castEndpoints, field, known, mapped, nativeType } from "../../model/facets.mjs";
export function duckdbEntityFacts(category, row) {
  switch (category) {
    case "keywords":
      return {
        spelling: row.name.toUpperCase(),
        nativeCategory: field(row, "category"),
        reserved: mapped(row, "category", {
          reserved: true,
          unreserved: false,
          column_name: false,
          type_function: false,
        }),
      };
    case "types":
      return { canonical: nativeType(row.logical_type), category: field(row, "category") };
    case "operators":
      return {
        operands:
          field(row, "arguments", "texts").status === "known"
            ? known(row.arguments.map(nativeType))
            : field(row, "arguments", "texts"),
        result: nativeType(row.result),
      };
    case "casts":
      return { ...castEndpoints(row), context: mapped(row, "implicit", { true: "implicit" }) };
    case "settings":
      return { valueType: field(row, "type"), scope: field(row, "scope") };
    default:
      return {};
  }
}
