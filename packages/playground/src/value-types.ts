export type WireValue =
  | null
  | boolean
  | number
  | string
  | { readonly kind: "undefined" }
  | { readonly kind: "bigint" | "date" | "bytes" | "number"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly WireValue[] }
  | { readonly kind: "object"; readonly entries: readonly (readonly [string, WireValue])[] };
