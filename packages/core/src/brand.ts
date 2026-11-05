declare const sqlBrand: unique symbol;

/** Application identity carried by a scalar without changing its wire representation. */
export type Brand<Value, Name extends string> = Value & { readonly [sqlBrand]: Name };

/** Establish an application identity after validating/obtaining a scalar at a trusted boundary. */
export function brandValue<Value extends string | number | bigint, const Name extends string>(
  value: Value,
  name: Name,
): Brand<Value, Name> {
  if (typeof name !== "string" || name.length === 0) throw new TypeError("A SQL brand requires a non-empty name");
  return value as Brand<Value, Name>;
}

/** Recover the unchanged wire scalar from a canonical schema brand type literal. */
export function brandBaseType(type: string): "string" | "number" | "bigint" | undefined {
  const match = /^import\("@typed-sql\/core"\)\.Brand<(string|number|bigint), ("(?:[^"\\]|\\.)*")>$/u.exec(type);
  if (match === null) return undefined;
  try {
    if (typeof JSON.parse(match[2]!) !== "string") return undefined;
    return match[1] as "string" | "number" | "bigint";
  } catch {
    return undefined;
  }
}
