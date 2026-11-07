// SDK debug strings can lose aliases inside containers. Preserve logical structure
// and JSON branding when producing the SQL type identity used by the live oracle.
export function duckDBNativeTypeText(type, ids, depth = 0) {
  if (depth > 64) throw new TypeError("Native DuckDB type exceeds the description depth bound");
  if (type.alias) return type.alias;
  const child = (value) => duckDBNativeTypeText(value, ids, depth + 1);
  const quote = (name) => `"${name.replaceAll('"', '""')}"`;
  if (type.typeId === ids.SQLNULL) return "NULL";
  if (type.typeId === ids.LIST) return `${child(type.valueType)}[]`;
  if (type.typeId === ids.ARRAY) return `${child(type.valueType)}[${type.length}]`;
  if (type.typeId === ids.MAP) return `MAP(${child(type.keyType)}, ${child(type.valueType)})`;
  if (type.typeId === ids.STRUCT) {
    if (type.isTuple) return `TUPLE(${type.entryTypes.map(child).join(", ")})`;
    return `STRUCT(${type.entryNames.map((name, index) => `${quote(name)} ${child(type.entryTypes[index])}`).join(", ")})`;
  }
  if (type.typeId === ids.UNION)
    return `UNION(${type.memberTags.map((name, index) => `${quote(name)} ${child(type.memberTypes[index])}`).join(", ")})`;
  return type.toString();
}
