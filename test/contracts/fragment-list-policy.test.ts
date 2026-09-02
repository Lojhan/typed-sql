import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";

const workspace = resolve(import.meta.dirname, "../..");
const policy = JSON.parse(await readFile(join(workspace, "fragment-list-policy.json"), "utf8")) as {
  readonly formatVersion: number;
  readonly separator: string;
  readonly classification: Readonly<Record<string, string>>;
  readonly explicitEmptyChoices: readonly string[];
  readonly compilerSourceForms: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly preparedCardinalityCache: string;
};

await describe("implicit fragment-list policy", async () => {
  await it("keeps implicit structure limited to a non-empty homogeneous fragment array", () => {
    strict.strictEqual(policy.formatVersion, 1);
    strict.strictEqual(policy.separator, ", ");
    strict.deepStrictEqual(policy.classification, {
      fragmentArray: "structural",
      nonEmptyValueArray: "parameter",
      emptyArray: "error",
      mixedArray: "error",
      nestedArray: "error",
      promiseArray: "error",
      iterable: "error",
    });
    strict.deepStrictEqual(policy.explicitEmptyChoices, ["sql.value", "sql.join", "sql.empty"]);
  });

  await it("bounds the initial compiler and prepared-cardinality surface", () => {
    strict.deepStrictEqual(policy.compilerSourceForms, ["direct-map", "fragment-array-literal"]);
    strict.deepStrictEqual(policy.limits, {
      items: 10_000,
      parameters: 65_535,
      renderedSqlBytes: 4 * 1024 * 1024,
      preparedCardinalityVariants: 32,
    });
    strict.strictEqual(policy.preparedCardinalityCache, "bounded-lru");
  });
});
