import { describe, it, strict } from "poku";
import { queryContractDigest } from "../src/index.js";
import {
  parseRecordedAnalysisQuery,
  parseRecordedQueryContract,
  type RecordedAnalysisQuery,
} from "../src/recorded-query.js";
import { fixture, runner } from "./helpers/live-fixture.js";

const request = fixture();
const query: RecordedAnalysisQuery = {
  candidate: request.candidate,
  context: request.staticClaim.context,
  adapter: request.adapter,
  connectionContext: request.connectionContext,
  policy: request.policy,
};
await describe("recorded-context lookup identity", async () => {
  await it("validates data without invoking source code or owner callbacks", () => {
    const parsed = parseRecordedAnalysisQuery(query);
    strict.ok(Object.isFrozen(parsed));
    strict.ok(Object.isFrozen(parsed.candidate));
    for (const invalid of [
      null,
      [],
      {},
      { ...query, staticClaim: request.staticClaim },
      { ...query, connectionContext: 1 },
      { ...query, connectionContext: "invalid" },
      { ...query, adapter: null },
      { ...query, adapter: [] },
      { ...query, adapter: {} },
      { ...query, adapter: { id: "", version: "1" } },
      { ...query, adapter: { id: "a", version: 1 } },
      { ...query, candidate: { sql: "SELECT 1", parameterOccurrences: [{ index: 1, start: -1, end: 3 }] } },
    ])
      strict.throws(() => parseRecordedAnalysisQuery(invalid as RecordedAnalysisQuery));
    let invoked = false;
    strict.throws(() =>
      parseRecordedAnalysisQuery({
        ...query,
        get context() {
          invoked = true;
          return query.context;
        },
      }),
    );
    strict.equal(invoked, false);
  });
  await it("matches proof, native owner, context and layout before accepting a contract", async () => {
    const outcome = await runner(request, new AbortController().signal);
    if (outcome.kind !== "usable-recorded-context") throw Error("Fixture failed qualification");
    strict.deepEqual(parseRecordedQueryContract(outcome.contract, query), outcome.contract);
    for (const changed of [
      { ...query, candidate: { ...query.candidate, sql: "SELECT 2 AS value" } },
      { ...query, context: { ...query.context, codecHash: queryContractDigest("changed") } },
      { ...query, policy: { ...query.policy, requiredNativeFacets: [] } },
      { ...query, adapter: { ...query.adapter, id: "other" } },
      { ...query, adapter: { ...query.adapter, version: "2" } },
      { ...query, candidate: { ...query.candidate, parameterOccurrences: [{ index: 1, start: 0, end: 1 }] } },
      { ...query, candidate: { ...query.candidate, columnSpans: [] } },
    ])
      strict.throws(() => parseRecordedQueryContract(outcome.contract, changed), /requested qualification/u);
    const { columnSpans: _, ...candidate } = query.candidate;
    strict.deepEqual(parseRecordedQueryContract(outcome.contract, { ...query, candidate }), outcome.contract);
  });
});
