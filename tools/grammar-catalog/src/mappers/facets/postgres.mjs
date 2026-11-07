import { castEndpoints, field, known, mapped, nativeType } from "../../model/facets.mjs";
export function postgresEntityFacts(category, row) {
  switch (category) {
    case "keywords":
      return {
        spelling: row.name.toUpperCase(),
        nativeCategory: field(row, "category"),
        reserved: mapped(row, "category", { R: true, U: false, C: false, T: false }),
      };
    case "types":
      return {
        canonical: nativeType(row.canonical_name),
        nativeKind: field(row, "kind"),
        category: field(row, "category"),
        defined: field(row, "defined", "boolean"),
        preferred: field(row, "preferred", "boolean"),
      };
    case "operators": {
      if (typeof row.left_type !== "string" || typeof row.right_type !== "string")
        return { result: nativeType(row.result) };
      const operands = [row.left_type, row.right_type].filter((type) => type !== "-");
      return {
        operands: known(operands.map(nativeType)),
        result: nativeType(row.result),
        fixity: known(row.left_type === "-" ? "prefix" : row.right_type === "-" ? "postfix" : "infix"),
      };
    }
    case "casts":
      return {
        ...castEndpoints(row),
        context: mapped(row, "context", { i: "implicit", a: "assignment", e: "explicit" }),
        method: field(row, "method"),
      };
    case "collations":
      return { provider: field(row, "provider"), encoding: field(row, "encoding", "integer") };
    case "settings":
      return {
        valueType: field(row, "type"),
        context: field(row, "context"),
        enumValues: field(row, "enumvals", "texts"),
      };
    case "extensions":
      return { defaultVersion: field(row, "default_version") };
    default:
      return {};
  }
}
