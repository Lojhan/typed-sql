import { describe, it, strict } from "poku";
import { type Brand, brandBaseType, brandValue } from "../src/index.js";

await describe("scalar brands", async () => {
  await it("keeps primitive runtime values and distinct compile-time identities", () => {
    const user: Brand<bigint, "UserId"> = brandValue(1n, "UserId");
    const post: Brand<bigint, "PostId"> = brandValue(1n, "PostId");
    strict.strictEqual(user, 1n);
    // @ts-expect-error Different application identities must not be assignable.
    const wrong: typeof user = post;
    void wrong;
    // @ts-expect-error An unbranded scalar is not a branded identity.
    const raw: typeof user = 1n;
    void raw;
    strict.throws(() => brandValue(1n, ""), /non-empty/u);
  });
  await it("recognizes only canonical scalar brand literals for wire validation", () => {
    for (const base of ["string", "number", "bigint"] as const)
      strict.strictEqual(brandBaseType(`import("@typed-sql/core").Brand<${base}, "Id">`), base);
    for (const type of [
      "bigint",
      'import("other").Brand<bigint, "Id">',
      'import("@typed-sql/core").Brand<boolean, "Id">',
      'import("@typed-sql/core").Brand<bigint, "\\x">',
    ])
      strict.strictEqual(brandBaseType(type), undefined);
  });
});
