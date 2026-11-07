import { postgres } from "@typed-sql/postgres";
import { describe, it, strict } from "poku";
import { analyzeSql, bindSql } from "../src/sql.js";
import { encodeValue } from "../src/values.js";
import { validateWorkerEvent } from "../src/worker-protocol.js";
import { snapshot } from "./helpers/fixture.js";

await describe("SQL binding and result transport contracts", async () => {
  const dialect = postgres();
  const schema = dialect.validateSnapshot(snapshot);
  await it("shares repeated named inputs and retains numeric positional order", () => {
    const named = analyzeSql(
      "select id from public.accounts where id=:accountId or id=:accountId",
      dialect,
      schema,
      undefined,
    );
    strict.equal(named.compiled.sourceDiagnostics.length, 0);
    strict.deepEqual(named.identities, ["accountId"]);
    strict.deepEqual(bindSql(named, [42]), [42, 42]);
    const reversed = analyzeSql("select id from public.accounts where id=$2 or id=$1", dialect, schema, undefined);
    strict.deepEqual(reversed.identities, ["$1", "$2"]);
    strict.deepEqual(bindSql(reversed, [1, 2]), [2, 1]);
    strict.throws(() => bindSql(named, ["wrong"]), /requires number/);
    strict.throws(() => bindSql(named, [null]), /does not accept NULL/);
  });
  await it("bounds encoding incrementally and rejects malformed IPC envelopes", () => {
    strict.throws(() => encodeValue({ secret: "x".repeat(500) }, { maxBytes: 100 }), /byte limit/);
    strict.throws(
      () =>
        encodeValue(
          Array.from({ length: 500 }, () => null),
          { maxNodes: 100 },
        ),
      /node limit/,
    );
    strict.throws(
      () =>
        validateWorkerEvent(
          {
            type: "result",
            name: "forged",
            value: { kind: "array", items: "invalid" },
            truncated: false,
            provenance: "managed",
          },
          1000,
        ),
      /Invalid/,
    );
    strict.throws(
      () =>
        validateWorkerEvent(
          {
            type: "result",
            name: "forged",
            value: null,
            truncated: false,
            provenance: "managed",
            target: { database: "x" },
          },
          1000,
        ),
      /target metadata/,
    );
    strict.throws(() => validateWorkerEvent({ type: "error", code: "x", message: "x".repeat(200) }, 100), /exceeds/);
    strict.deepEqual(validateWorkerEvent({ type: "done" }, 100), { type: "done" });
  });
});
