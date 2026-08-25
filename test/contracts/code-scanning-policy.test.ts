import { describe, it, strict } from "poku";
import {
  assertCodeScanningPolicy,
  blockingCodeScanningAlerts,
  type CodeScanningAlert,
  fetchOpenCodeScanningAlerts,
} from "../../scripts/code-scanning-policy.mjs";

function alert(number: number, severity: string): CodeScanningAlert {
  return {
    number,
    rule: { id: `test/rule-${number}`, security_severity_level: severity },
    most_recent_instance: { location: { path: `src/file-${number}.ts` } },
  };
}

await describe("CodeQL release policy", async () => {
  await it("blocks critical and high alerts while allowing lower severities", () => {
    strict.deepStrictEqual(
      blockingCodeScanningAlerts([alert(1, "critical"), alert(2, "high"), alert(3, "medium"), alert(4, "low")]).map(
        (item) => item.number,
      ),
      [1, 2],
    );
  });

  await it("paginates through every open alert", async () => {
    const pages = [Array.from({ length: 100 }, (_, index) => alert(index + 1, "medium")), [alert(101, "low")]];
    const requestedPages: string[] = [];
    const alerts = await fetchOpenCodeScanningAlerts("Lojhan/typed-sql", {
      token: "test-token",
      fetch: async (input) => {
        const url = new URL(String(input));
        requestedPages.push(url.searchParams.get("page") ?? "");
        return Response.json(pages.shift() ?? []);
      },
    });
    strict.strictEqual(alerts.length, 101);
    strict.deepStrictEqual(requestedPages, ["1", "2"]);
  });

  await it("fails closed for alerts and API errors", async () => {
    await strict.rejects(
      assertCodeScanningPolicy({
        repository: "Lojhan/typed-sql",
        token: "test-token",
        fetch: async () => Response.json([alert(11, "high")]),
      }),
      /#11 high test\/rule-11 at src\/file-11\.ts/u,
    );
    await strict.rejects(
      fetchOpenCodeScanningAlerts("Lojhan/typed-sql", {
        token: "test-token",
        fetch: async () => new Response("forbidden", { status: 403 }),
      }),
      /lookup failed \(403\): forbidden/u,
    );
  });
});
