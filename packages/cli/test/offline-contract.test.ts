import { describe, it, strict } from "poku";
import { context, profile, request, schema } from "../../analysis/test/helpers/host-fixture.js";
import { unknownQuerySemantics } from "../../core/src/index.js";
import { materializeOfflineContract } from "../src/offline-contract.js";

const sql = request.candidate.sql,
  range = { start: 0, end: sql.length, line: 1, column: 1 };
const analysis = {
  columns: request.staticClaim.columns.map((column) => ({ ...column, range })),
  parameters: [],
  diagnostics: [],
  resultKind: "rows" as const,
  semantics: unknownQuerySemantics(range, "fixture"),
};
const options = { sql, context, schema, typePolicy: {}, parameterCount: 0 };
await describe("offline contract materialization", async () => {
  await it("preserves validated scalar plans and command result identity", () => {
    const selected = materializeOfflineContract({ ...options, dialect: { ...profile, analyze: () => analysis } });
    strict.equal(selected.valuePlan.columns[0]?.type, "number");
    strict.equal(selected.resultKind, "rows");
    const command = materializeOfflineContract({
      ...options,
      dialect: { ...profile, analyze: () => ({ ...analysis, columns: [], resultKind: "command" as const }) },
    });
    strict.equal(command.resultKind, "command");
    strict.deepEqual(command.valuePlan.columns, []);
  });
  await it("does not turn partial identities, unsupported logical refinements or missing parameters into exact artifacts", () => {
    for (const columns of [
      [{ ...analysis.columns[0]!, databaseTypeIsPartial: true as const }],
      [{ ...analysis.columns[0]!, tsType: "UserId" }],
      [{ ...analysis.columns[0]!, runtimeType: "unknown" as const }],
    ])
      strict.throws(
        () =>
          materializeOfflineContract({
            ...options,
            dialect: { ...profile, analyze: () => ({ ...analysis, columns }) },
          }),
        /Offline contract generation/u,
      );
    strict.throws(
      () =>
        materializeOfflineContract({ ...options, parameterCount: 1, dialect: { ...profile, analyze: () => analysis } }),
      /logical types/u,
    );
    strict.throws(
      () =>
        materializeOfflineContract({
          ...options,
          dialect: {
            ...profile,
            analyze: () => ({
              ...analysis,
              diagnostics: [{ code: "TSQ202", severity: "error", message: "Unknown function", range }],
            }),
          },
        }),
      /successful grammar analysis/u,
    );
  });
});
