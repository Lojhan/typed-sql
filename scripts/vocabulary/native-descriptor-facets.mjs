// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const toolDigest = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .digest("hex");

/** @typedef {import('../../packages/analysis/src/index.js').NativeContractValueEvidence} Field */
/** @typedef {{status:string, columns?:readonly string[], parameters?:readonly string[]}} Outcome */
/** @typedef {{adapter?:Outcome, policy?:string} & Partial<Outcome>} Observation */

const empty = () => ({
  occurrences: 0,
  nativeType: { complete: 0, partial: 0, unavailable: 0 },
  runtimeType: { known: 0, unavailable: 0 },
  nullable: { exactNonNull: 0, exactNullable: 0, upperBound: 0, unavailable: 0 },
  reasons: /** @type {Record<string,number>} */ ({}),
});

/**
 * Counts field occurrences in actual acquired descriptions, not distinct names or SQL coverage.
 * Flat and adapter-nested collector observations share this format; no grammar/type list is used.
 * @param {{fields:Readonly<Record<string,Field>>, observations:readonly Observation[]}} input
 */
function summarizeFields({ fields, observations }) {
  const columns = empty(),
    parameters = empty(),
    outcomes = /** @type {Record<string,number>} */ ({});
  let withoutFieldEvidence = 0;
  for (const observation of observations) {
    const outcome = observation.adapter ?? observation;
    assert.ok(typeof outcome.status === "string" && outcome.status.length > 0);
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    if (outcome.status !== "acquired") {
      assert.equal(outcome.columns, undefined, "Unacquired observations cannot claim field evidence");
      assert.equal(outcome.parameters, undefined, "Unacquired observations cannot claim field evidence");
      withoutFieldEvidence++;
      continue;
    }
    for (const [kind, summary] of /** @type {const} */ ([
      ["columns", columns],
      ["parameters", parameters],
    ])) {
      assert.ok(Array.isArray(outcome[kind]), "Acquired descriptions must retain both field lists");
      for (const key of outcome[kind]) {
        assert.ok(Object.hasOwn(fields, key), "Descriptor field reference is missing");
        const field = fields[key];
        assert.ok(field);
        summary.occurrences++;
        /** @type {{[K in Exclude<keyof Field,'descriptor'>]:()=>void}} */
        const count = {
          nativeType() {
            const fact = field.nativeType;
            if (fact.status === "unknown") summary.nativeType.unavailable++;
            else {
              assert.equal(typeof fact.value.complete, "boolean");
              summary.nativeType[fact.value.complete ? "complete" : "partial"]++;
            }
          },
          runtimeType() {
            const fact = field.runtimeType;
            summary.runtimeType[
              fact.status === "unknown" || fact.value === "unknown" || fact.value === "never" ? "unavailable" : "known"
            ]++;
          },
          nullable() {
            const fact = field.nullable;
            if (fact.status === "unknown") summary.nullable.unavailable++;
            else {
              assert.equal(typeof fact.value, "boolean");
              assert.ok(fact.precision === "exact" || fact.precision === "upper-bound");
              // A false nullable upper bound excludes NULL and is a complete non-null guarantee.
              if (!fact.value) summary.nullable.exactNonNull++;
              else summary.nullable[fact.precision === "exact" ? "exactNullable" : "upperBound"]++;
            }
          },
        };
        assert.deepEqual(Object.keys(field).sort(), [...Object.keys(count), "descriptor"].sort());
        for (const [facet, visit] of Object.entries(count)) {
          const fact = field[/** @type {Exclude<keyof Field,'descriptor'>} */ (facet)];
          assert.ok(fact.status === "known" || fact.status === "unknown");
          if (fact.status === "unknown") {
            assert.ok(typeof fact.reason === "string" && fact.reason.length > 0);
            const reason = `${facet}:${fact.reason}`;
            summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
          }
          visit();
        }
      }
    }
  }
  return {
    formatVersion: 1,
    toolDigest,
    observations: observations.length,
    outcomes,
    withoutFieldEvidence,
    columns,
    parameters,
  };
}

/** @param {{fields:Readonly<Record<string,Field>>, observations:readonly Observation[]}} input */
export function summarizeNativeDescriptorFacets(input) {
  const policies = [
    ...new Set(input.observations.flatMap((item) => (item.policy === undefined ? [] : [item.policy]))),
  ].sort();
  if (policies.length)
    assert.ok(input.observations.every((item) => typeof item.policy === "string" && item.policy.length > 0));
  return {
    ...summarizeFields(input),
    byPolicy: Object.fromEntries(
      policies.map((policy) => [
        policy,
        summarizeFields({
          fields: input.fields,
          observations: input.observations.filter((item) => item.policy === policy),
        }),
      ]),
    ),
  };
}
