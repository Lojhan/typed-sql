import { describe, it, strict } from "poku";
import { ResponseError } from "vscode-jsonrpc/node";
import { recoverDiagnosticPull } from "../src/diagnostic-response.js";

const token = { isCancellationRequested: false };
const diagnostic = { code: "TYPED_SQL_PROJECT_UNAVAILABLE", message: "redacted failure" };
await describe("diagnostic pull recovery", async () => {
  await it("contains failures after asynchronous analysis and allows the next pull to recover", async () => {
    const report = await recoverDiagnosticPull(
      async () => {
        await Promise.resolve();
        throw new Error("private schema path failed validation");
      },
      token,
      () => diagnostic,
    );
    strict.deepStrictEqual(report, { kind: "full", items: [diagnostic] });
    const recovered = { kind: "full", items: [{ message: "current assignment error" }] };
    strict.strictEqual(
      await recoverDiagnosticPull(
        async () => recovered,
        token,
        () => diagnostic,
      ),
      recovered,
    );
  });
  await it("requests diagnostic retries for stale or cancelled snapshots instead of empty reports", async () => {
    for (const error of [
      new ResponseError(-32801, "stale"),
      new ResponseError(-32800, "cancelled"),
      new ResponseError(-32802, "server cancelled"),
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
    ]) {
      await strict.rejects(
        () =>
          recoverDiagnosticPull(
            async () => {
              throw error;
            },
            token,
            () => diagnostic,
          ),
        (result: unknown) =>
          result instanceof ResponseError && result.code === -32802 && result.data.retriggerRequest === true,
      );
    }
    await strict.rejects(
      () =>
        recoverDiagnosticPull(
          async () => {
            throw new Error("cancelled work");
          },
          { isCancellationRequested: true },
          () => diagnostic,
        ),
      (result: unknown) => result instanceof ResponseError && result.code === -32802,
    );
  });
});
