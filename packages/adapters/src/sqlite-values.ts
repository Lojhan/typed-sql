import type { RuntimeValueType } from "@typed-sql/core";
import type { BufferedOptions } from "./index.js";

/** Normalize each driver's SQLite wire containers before logical grammar-policy validation. */
export function sqliteWireOptions(options: BufferedOptions, d1: boolean): BufferedOptions {
  return {
    ...options,
    profile: {
      ...options.profile,
      normalizeValue(value, type) {
        const members: readonly RuntimeValueType[] = typeof type === "object" && "union" in type ? type.union : [type];
        let normalized = value;
        if (members.includes("bytes")) {
          if (value instanceof ArrayBuffer) normalized = new Uint8Array(value);
          else if (d1 && Array.isArray(value)) {
            if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
              throw new TypeError("D1 returned invalid BLOB bytes");
            normalized = Uint8Array.from(value);
          }
        }
        if (members.includes("number") && !members.includes("bigint") && typeof normalized === "bigint") {
          const number = Number(normalized);
          if (!Number.isSafeInteger(number))
            throw new RangeError("SQLite integer exceeds the requested number precision");
          normalized = number;
        } else if (
          members.length === 1 &&
          members[0] === "bigint" &&
          typeof normalized === "string" &&
          /^[+-]?\d+$/u.test(normalized)
        )
          normalized = BigInt(normalized);
        else if (!d1 && members.length === 1 && members[0] === "bigint" && typeof normalized === "number") {
          if (!Number.isSafeInteger(normalized)) throw new RangeError("SQLite driver lost integer precision");
          normalized = BigInt(normalized);
        }
        return options.profile.normalizeValue?.(normalized, type) ?? normalized;
      },
    },
  };
}
