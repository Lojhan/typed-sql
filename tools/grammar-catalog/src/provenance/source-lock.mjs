import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../model/canonical.mjs";
import { assertJson } from "../model/json.mjs";

/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1 }),
  digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  revision = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
export const SourceLockSchema = object({
  formatVersion: Type.Literal(1),
  grammar: text,
  extractor: object({ id: text, revision: digest }),
  sources: Type.Array(
    object({
      version: text,
      reference: text,
      repository: Type.String({ pattern: "^https://" }),
      revision,
      upstreamRevision: revision,
      files: Type.Record(text, object({ digest, bytes: Type.Integer({ minimum: 0 }) }), { minProperties: 1 }),
      license: object({ identifier: text, path: text }),
      defines: Type.Array(text, { uniqueItems: true }),
      factsDigest: digest,
    }),
    { minItems: 1 },
  ),
});
const checker = TypeCompiler.Compile(SourceLockSchema);
/** @param {unknown} input @returns {import('@sinclair/typebox').Static<typeof SourceLockSchema>} */
export function parseSourceLock(input) {
  assertJson(input);
  if (!checker.Check(input)) throw new TypeError("Invalid vendor source lock");
  const versions = new Set();
  for (const source of input.sources) {
    if (versions.has(source.version)) throw new TypeError(`Duplicate source version: ${source.version}`);
    versions.add(source.version);
    for (const path of Object.keys(source.files))
      if (
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(path) ||
        path.split("/").some((part) => part === "." || part === "..")
      )
        throw new TypeError(`Noncanonical source path: ${path}`);
    if (!Object.hasOwn(source.files, source.license.path)) throw new TypeError("Source license evidence is not locked");
  }
  return input;
}
export function checkLockedFacts(input, facts, validateFacts) {
  const lock = parseSourceLock(input);
  assertJson(facts);
  if (facts?.formatVersion !== 1 || facts.grammar !== lock.grammar || !facts.versions || Array.isArray(facts.versions))
    throw new TypeError("Invalid vendor fact envelope");
  if (Object.keys(facts.versions).length !== lock.sources.length)
    throw new TypeError("Vendor source/fact version coverage differs");
  for (const source of lock.sources) {
    const value = facts.versions[source.version];
    if (
      !value ||
      value.version !== source.version ||
      value.revision !== source.revision ||
      hash(value.defines) !== hash(source.defines) ||
      hash(value) !== source.factsDigest
    )
      throw new TypeError(`Vendor facts disagree with source lock: ${source.version}`);
    validateFacts(value);
  }
  return lock;
}

/** Verify acquired bytes before a source adapter compiles or interprets them. */
export async function verifySourceFiles(directory, files) {
  const { readFile, realpath } = await import("node:fs/promises");
  const { resolve, relative, isAbsolute } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const root = await realpath(directory);
  for (const [path, expected] of Object.entries(files)) {
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw new TypeError("Noncanonical acquired source path");
    const file = await realpath(resolve(root, path)),
      local = relative(root, file);
    if (local.startsWith("..") || isAbsolute(local)) throw new TypeError("Acquired source escapes archive");
    const bytes = await readFile(file),
      digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== expected.digest || bytes.length !== expected.bytes)
      throw new TypeError(`Acquired source bytes disagree: ${path}`);
  }
}
