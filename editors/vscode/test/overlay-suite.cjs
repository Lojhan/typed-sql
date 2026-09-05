const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const vscode = require("vscode");

async function eventually(label, check) {
  const deadline = Date.now() + 25_000;
  let last;
  do {
    try {
      return await check();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${last?.stack ?? last}`);
}

exports.run = async () => {
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
  const hover = async (needle, offset = 0) => {
    const result = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position(needle, offset));
    return (result ?? []).flatMap((item) => item.contents.map((content) => content.value ?? content)).join("\n");
  };
  await eventually("inferred row member hover", async () => {
    assert.match(await hover("return row.name", "return row.".length), /name.*string/s);
  });
  await eventually("inferred row completion", async () => {
    const result = await vscode.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      uri,
      position("return row.name", "return row.".length),
      undefined,
      10,
    );
    const labels = result.items.map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    assert.ok(labels.includes("id") && labels.includes("name"), JSON.stringify(labels));
  });
  await eventually("mapped TypeScript diagnostic", async () => {
    const diagnostics = vscode.languages
      .getDiagnostics(uri)
      .filter((item) => item.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(
      diagnostics.some((item) => item.range.start.line === 7 && /string.*number/s.test(item.message)),
      JSON.stringify(diagnostics),
    );
    assert.ok(!diagnostics.some((item) => item.range.start.line === 6), "correct assignment must not fail");
  });
  const definitions = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    uri,
    position("void ordinary.count", "void ".length),
  );
  assert.ok(
    definitions.some((item) => {
      const range = item.targetSelectionRange ?? item.range;
      return (item.targetUri ?? item.uri).toString() === uri.toString() && document.getText(range) === "ordinary";
    }),
    "ordinary definition after same-line SQL overlay must map to original source",
  );
  assert.match(await hover("ordinary.count", "ordinary.".length), /number/);

  const edit = new vscode.WorkspaceEdit();
  const start = position("id, name FROM");
  edit.replace(uri, new vscode.Range(start, start.translate(0, "id, name".length)), "id, age AS name");
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(document.isDirty, true, "overlay refresh must use an unsaved editor change");
  await eventually("unsaved query invalidates inferred type", async () => {
    const value = await hover("return row.name", "return row.".length);
    assert.match(value, /name.*number/s);
    assert.match(value, /null/);
    assert.doesNotMatch(value, /name.*string/s);
  });
  await eventually("diagnostics follow refreshed overlay", async () => {
    assert.ok(
      vscode.languages
        .getDiagnostics(uri)
        .some((item) => item.range.start.line === 6 && /number|nullable|null/.test(item.message)),
    );
  });
  const invalid = new vscode.WorkspaceEdit();
  const age = position("age AS name");
  invalid.replace(uri, new vscode.Range(age, age.translate(0, 3)), "not_a_column");
  assert.equal(await vscode.workspace.applyEdit(invalid), true);
  await eventually("SQL diagnostics survive pull delivery", async () => {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    assert.ok(
      diagnostics.some((item) => item.source === "typed-sql" && /not_a_column/.test(item.message)),
      JSON.stringify(diagnostics),
    );
  });
  writeFileSync(
    process.env.TYPED_SQL_HOST_REPORT,
    JSON.stringify({
      mode: "overlays",
      vscode: vscode.version,
      passed: true,
      checks: [
        "row-hover",
        "row-completion",
        "typescript-diagnostic",
        "source-definition",
        "ordinary-hover",
        "unsaved-query-refresh",
        "sql-diagnostic",
      ],
    }),
  );
};
