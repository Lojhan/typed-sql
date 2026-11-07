export function assertJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 128) throw new TypeError("Catalog JSON exceeds the depth bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new TypeError("Catalog contains a non-JSON value");
  if (ancestors.has(value)) throw new TypeError("Catalog contains a cyclic value");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError("Catalog contains a non-JSON object");
  const keys = Object.keys(value);
  if (Array.isArray(value) && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
    throw new TypeError("Catalog contains a sparse array or array properties");
  if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0))
    throw new TypeError("Catalog contains non-JSON properties");
  ancestors.add(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Catalog contains an accessor");
    assertJson(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
