import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { grammarCases, interfaces, sourceFor } from "../editor-hub/cases.mjs";
import { buildMatrix, pendingInterfaces } from "../editor-hub/matrix.mjs";

await describe("editor grammar evidence hub", async () => {
  await it("retains host failure evidence even when an editor job fails", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    strict.match(workflow, /run: pnpm editor:artifacts:smoke\s+- if: always\(\)\s+uses: actions\/upload-artifact/u);
  });
  await it("covers owned grammars and the external grammar without homogenizing semantics", () => {
    strict.deepStrictEqual(
      grammarCases.map((item) => item.id),
      ["postgres", "mysql", "sqlite", "synthetic"],
    );
    for (const spec of grammarCases) {
      strict.strictEqual(spec.schema.dialect, spec.id);
      strict.ok(sourceFor(spec).includes(spec.packageName));
      strict.ok(sourceFor(spec, spec.changed).includes(spec.changed.query));
      strict.notStrictEqual(spec.initial.type, spec.changed.type);
      strict.notStrictEqual(spec.initial.query, spec.invalidQuery);
    }
    strict.strictEqual(grammarCases[3]!.initial.member, "value");
    strict.strictEqual(grammarCases[3]!.changed.member, "label");
  });
  await it("starts every editor/grammar/interface cell as not run", () => {
    const matrix = buildMatrix([]);
    strict.strictEqual(matrix.cells.length, 2 * 4 * (interfaces.length + pendingInterfaces.length));
    strict.ok(matrix.cells.every((cell) => cell.status === "not-run"));
  });
  await it("records schema lifecycle coverage without inventing synthetic column semantics", () => {
    strict.ok(interfaces.includes("schema-file-refresh"));
    strict.ok(!pendingInterfaces.includes("schema-file-refresh"));
    for (const spec of grammarCases.filter((item) => item.id !== "synthetic")) {
      strict.deepStrictEqual(spec.schemaRefresh, { table: "users", column: "name", type: "string | null" });
    }
    strict.strictEqual(grammarCases.find((item) => item.id === "synthetic")!.schemaRefresh, undefined);
  });
  await it("does not promote partial, protocol or duplicate evidence into full host coverage", () => {
    const report = {
      editor: "vscode",
      grammar: "postgres",
      evidence: "actual-host",
      vscode: "1.134.0",
      checks: {
        "row-hover": { status: "passed" },
        "row-completion": { status: "failed", error: "missing name" },
      },
    };
    const matrix = buildMatrix([report]);
    strict.strictEqual(matrix.cells.filter((cell) => cell.status === "passed").length, 1);
    strict.strictEqual(matrix.cells.filter((cell) => cell.status === "failed").length, 1);
    strict.ok(matrix.cells.filter((cell) => cell.editor === "zed").every((cell) => cell.status === "not-run"));
    strict.throws(() => buildMatrix([{ ...report, evidence: "protocol" }]), /protocol evidence/);
    strict.throws(() => buildMatrix([report, report]), /duplicate/);
    strict.throws(() => buildMatrix([{ ...report, grammar: "unknown" }]), /unknown grammar/);
    strict.throws(() => buildMatrix([{ ...report, checks: { invented: { status: "passed" } } }]), /unknown interface/);
    strict.throws(() => buildMatrix([{ ...report, checks: { "row-hover": { status: "skipped" } } }]), /unknown status/);
  });
});
