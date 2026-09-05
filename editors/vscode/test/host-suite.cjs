const assert = require("node:assert/strict");
const { existsSync, writeFileSync } = require("node:fs");
const vscode = require("vscode");

exports.run = async () => {
  const mode = process.env.TYPED_SQL_HOST_MODE;
  const trusted = mode !== "untrusted";
  assert.equal(vscode.workspace.isTrusted, trusted, "host must enter the intended trust mode");
  assert.equal(vscode.workspace.workspaceFolders[0].uri.scheme === "file", mode !== "virtual");
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "query.ts"),
  );
  await vscode.window.showTextDocument(document);
  const target = vscode.extensions.getExtension("lojhan.typed-sql");
  if (mode === "trusted") {
    assert.ok(target, "packaged extension must be installed");
    await target.activate();
    assert.equal(target.isActive, true);
    assert.ok(existsSync(process.env.TYPED_SQL_HOST_MARKER), "trusted activation must start the configured server");
  } else {
    assert.equal(
      target,
      undefined,
      "unsupported extension must be excluded from the host registry, not merely awaiting activation",
    );
    assert.ok(!existsSync(process.env.TYPED_SQL_HOST_MARKER), "unsupported workspace must not execute its server");
  }
  writeFileSync(process.env.TYPED_SQL_HOST_REPORT, JSON.stringify({ mode, vscode: vscode.version, passed: true }));
};
