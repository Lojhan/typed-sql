import { type CancellationToken, ResponseError } from "vscode-jsonrpc/node";

/** Keep late analysis failures from stranding a client's diagnostic pull state. */
export async function recoverDiagnosticPull(
  operation: () => Promise<unknown>,
  token: Pick<CancellationToken, "isCancellationRequested">,
  failureDiagnostic: (error: unknown) => unknown,
): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (
      token.isCancellationRequested ||
      (error instanceof Error && error.name === "AbortError") ||
      (error instanceof ResponseError && [-32800, -32801, -32802].includes(error.code))
    ) {
      // ContentModified becomes an empty report in some pull clients. Diagnostic
      // server cancellation explicitly requests a retry for a fresh snapshot.
      throw new ResponseError(-32802, "Diagnostic snapshot changed; retry the request", { retriggerRequest: true });
    }
    // Do not cache this transient report: a subsequent pull can recover.
    return { kind: "full", items: [failureDiagnostic(error)] };
  }
}
