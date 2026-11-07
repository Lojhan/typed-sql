import { createHash } from "node:crypto";

export const canonical = (value) =>
  typeof value === "bigint"
    ? value.toString()
    : Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;

export const hash = (value) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
