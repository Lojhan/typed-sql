import { execFileSync } from "node:child_process";
import { describe, it, strict } from "poku";
import { canonicalizeSchemaValue } from "../src/index.js";

await describe("portable artifact hashes", async () => {
  await it("uses explicit collation with a total ordering for equivalent Unicode keys", () => {
    strict.deepStrictEqual(
      canonicalizeSchemaValue({ é: 1, "e\u0301": 2, z: 3 }),
      canonicalizeSchemaValue({ z: 3, "e\u0301": 2, é: 1 }),
    );
    strict.strictEqual(
      JSON.stringify(canonicalizeSchemaValue({ é: 1, "e\u0301": 2 })),
      JSON.stringify(canonicalizeSchemaValue({ "e\u0301": 2, é: 1 })),
    );
  });

  await it("keeps new identities portable and verifies old identities without accepting changed content", () => {
    const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
    const codecUrl = new URL("../src/v2/codec.ts", import.meta.url).href;
    const script = `
      import { createHash } from 'node:crypto';
      import assert from 'node:assert/strict';
      import { calculateSchemaHash, calculateTypePolicyHash, matchesSchemaHash, matchesTypePolicyHash,
        checkSchemaDrift, serializeSchemaSnapshot, upgradeSchemaSnapshotV1 } from ${JSON.stringify(moduleUrl)};
      import { parseSchemaSnapshotV2, schemaSnapshotV2Envelope } from ${JSON.stringify(codecUrl)};
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)])) : value;
      const legacyHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
      const policy = { z: { z: 1, ä: 2 }, ä: [1, 2] };
      const v1 = { formatVersion: 1, dialect: 'test', tables: {}, enums: { z: ['z'], ä: ['ä'] } };
      const base = upgradeSchemaSnapshotV1(v1);
      const index = identity => ({ name: identity, identity, unique: false, columns: [], predicate: 'none', valid: true });
      const schema = { ...base, relations: { t: { name: 't', kind: 'table', columns: {}, constraints: [], indexes: [index('z'), index('ä')] } } };
      const legacy = legacyHash(schemaSnapshotV2Envelope(parseSchemaSnapshotV2(schemaSnapshotV2Envelope(schema), (a,b) => a.localeCompare(b))));
      assert(matchesSchemaHash(v1, legacyHash(v1)));
      assert(matchesSchemaHash(schema, legacy));
      assert(matchesSchemaHash(schema, calculateSchemaHash(schema)));
      assert(!matchesSchemaHash({ ...schema, dialect: 'other' }, legacy));
      assert(matchesTypePolicyHash(policy, legacyHash(policy)));
      assert(matchesTypePolicyHash(policy, calculateTypePolicyHash(policy)));
      assert(!matchesTypePolicyHash({}, legacyHash(policy)));
      assert.equal(checkSchemaDrift({ ...schema, metadata: { generatorVersion: 'legacy', schemaHash: legacy, typePolicyHash: legacyHash(policy) } }, schema, policy).drifted, false);
      process.stdout.write(JSON.stringify({ schema: calculateSchemaHash(schema), policy: calculateTypePolicyHash(policy), serialized: serializeSchemaSnapshot(schema), legacy }));
    `;
    const run = (locale: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
          encoding: "utf8",
          env: { ...process.env, LANG: locale, LC_ALL: locale },
        }),
      ) as { schema: string; policy: string; serialized: string; legacy: string };
    const english = run("en_US.UTF-8");
    const swedish = run("sv_SE.UTF-8");
    strict.notStrictEqual(english.legacy, swedish.legacy);
    strict.strictEqual(english.schema, swedish.schema);
    strict.strictEqual(english.policy, swedish.policy);
    strict.strictEqual(english.serialized, swedish.serialized);
  });
});
