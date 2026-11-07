// One signature/observation per line keeps generated evidence reviewable.
export function serialize(value, indent = 0) {
  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const flat = (item) =>
      item === null ||
      typeof item !== "object" ||
      typeof item.sql === "string" ||
      Boolean(item.signature) ||
      (Array.isArray(item)
        ? item.every((entry) => entry === null || typeof entry !== "object")
        : Object.values(item).every(
            (entry) =>
              entry === null ||
              typeof entry !== "object" ||
              (Array.isArray(entry) && entry.every((child) => child === null || typeof child !== "object")),
          ));
    return `[\n${value.map((item) => `${padding}  ${flat(item) ? JSON.stringify(item) : serialize(item, indent + 2)}`).join(",\n")}\n${padding}]`;
  }
  if (value && typeof value === "object") {
    if (typeof value.sql === "string" || value.signature) return JSON.stringify(value);
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([key, item]) => `${padding}  ${JSON.stringify(key)}: ${serialize(item, indent + 2)}`).join(",\n")}\n${padding}}`;
  }
  return JSON.stringify(value);
}
