const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const vscode = require("vscode");

exports.run = async () => {
  const { grammarCases, interfaces } = await import("../../../test/editor-hub/cases.mjs");
  const { runScenario } = await import("../../../test/editor-hub/scenario.mjs");
  const spec = grammarCases.find((item) => item.id === process.env.TYPED_SQL_HOST_GRAMMAR);
  assert.ok(spec, "the host must select an explicit grammar case");
  const report = {
    mode: "overlays",
    editor: "vscode",
    grammar: spec.id,
    vscode: vscode.version,
    evidence: "actual-host",
    passed: false,
    checks: Object.fromEntries(interfaces.map((id) => [id, { status: "not-run" }])),
  };
  const save = () => writeFileSync(process.env.TYPED_SQL_HOST_REPORT, JSON.stringify(report));
  save();
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.extensions.getExtension("vscode.typescript-language-features"), undefined);
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "query.ts");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const target = vscode.extensions.getExtension("lojhan.typed-sql");
  assert.ok(target);
  await target.activate();
  const position = (needle, offset = 0) => {
    const index = document.getText().indexOf(needle);
    assert.notEqual(index, -1, needle);
    return document.positionAt(index + offset);
  };
  await runScenario(
    spec,
    {
      async hover(needle, offset) {
        const result = await vscode.commands.executeCommand(
          "vscode.executeHoverProvider",
          uri,
          position(needle, offset),
        );
        return (result ?? []).flatMap((item) => item.contents.map((content) => content.value ?? content)).join("\n");
      },
      async completions(needle, offset) {
        const result = await vscode.commands.executeCommand(
          "vscode.executeCompletionItemProvider",
          uri,
          position(needle, offset),
          undefined,
          10,
        );
        return (result?.items ?? []).map((item) => (typeof item.label === "string" ? item.label : item.label.label));
      },
      async diagnostics() {
        return vscode.languages.getDiagnostics(uri).map((item) => ({
          error: item.severity === vscode.DiagnosticSeverity.Error,
          line: item.range.start.line,
          source: item.source,
          message: item.message,
        }));
      },
      async definitions(needle, offset) {
        const result = await vscode.commands.executeCommand(
          "vscode.executeDefinitionProvider",
          uri,
          position(needle, offset),
        );
        return (result ?? []).map((item) => ({
          ownDocument: (item.targetUri ?? item.uri).toString() === uri.toString(),
          text: document.getText(item.targetSelectionRange ?? item.range),
        }));
      },
      async replace(source) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          source,
        );
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.equal(document.isDirty, true, "refresh must exercise an unsaved editor change");
      },
    },
    (id, status, error) => {
      report.checks[id] = { status, ...(error === undefined ? {} : { error }) };
      save();
    },
  );
  report.passed = true;
  save();
};
