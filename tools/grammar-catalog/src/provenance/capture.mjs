import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../model/canonical.mjs";
import { assertJson } from "../model/json.mjs";

const text = Type.String({ minLength: 1, pattern: "\\S" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
export const CaptureProvenanceSchema = object({
  formatVersion: Type.Literal(1),
  captureDigest: digest,
  extractor: object({
    id: text,
    revision: digest,
    files: Type.Record(text, digest, { minProperties: 1 }),
    dependencyLock: digest,
    runtime: object({ name: Type.Literal("node"), version: text }),
  }),
});
const checker = TypeCompiler.Compile(CaptureProvenanceSchema);
/** @param {{grammar:string,target:unknown,categories:unknown}} capture */
const captureDigest = (capture) =>
  hash({ grammar: capture.grammar, target: capture.target, categories: capture.categories });
/** @param {unknown} value
 * @returns {import('@sinclair/typebox').Static<typeof CaptureProvenanceSchema>}
 */
export function parseCaptureProvenance(value) {
  assertJson(value);
  if (!checker.Check(value)) throw new TypeError("Invalid native capture provenance");
  for (const path of Object.keys(value.extractor.files))
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw new TypeError(`Noncanonical extractor path: ${path}`);
  const { revision, ...extractor } = value.extractor;
  if (revision !== hash(extractor)) throw new TypeError("Native extractor manifest digest differs");
  return value;
}
/** @param {unknown} input @param {{grammar:string,target:unknown,categories:unknown}} capture */
export function validateCaptureProvenance(input, capture) {
  const value = parseCaptureProvenance(input);
  if (value.captureDigest !== captureDigest(capture)) throw new TypeError("Native provenance capture digest differs");
  return value;
}
/** @param {{grammar:string,target:unknown,categories:unknown}} capture
 * @param {Omit<import('@sinclair/typebox').Static<typeof CaptureProvenanceSchema>['extractor'],'revision'>} extractor */
export function createCaptureProvenance(capture, extractor) {
  return validateCaptureProvenance(
    { formatVersion: 1, captureDigest: captureDigest(capture), extractor: { ...extractor, revision: hash(extractor) } },
    capture,
  );
}
