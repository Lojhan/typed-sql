const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const vscode = require("vscode");
const events = () =>
  existsSync(process.env.TYPED_SQL_HOST_MARKER)
    ? readFileSync(process.env.TYPED_SQL_HOST_MARKER, "utf8").trim().split("\n").map(JSON.parse)
    : [];
async function eventually(check) {
  const deadline = Date.now() + 25_000;
  let last;
  do {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw last;
}
exports.run = async () => {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "query.ts");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension("lojhan.typed-sql");
  assert.ok(extension);
  await extension.activate();
  assert.deepEqual(events(), [], "missing path must not launch a server");
  const settings = vscode.workspace.getConfiguration("typedSql", uri);
  await settings.update("serverPath", process.env.TYPED_SQL_HOST_PROBE, vscode.ConfigurationTarget.Workspace);
  await eventually(() => assert.ok(events().some((event) => event.event === "start")));
  // The probe intentionally delays initialize: change settings while startup is
  // in flight, when the old implementation did not yet register its client.
  await settings.update("analysisDebounceMs", 21, vscode.ConfigurationTarget.Workspace);
  await settings.update("analysisDebounceMs", 22, vscode.ConfigurationTarget.Workspace);
  await settings.update("analysisDebounceMs", 23, vscode.ConfigurationTarget.Workspace);
  let count = 0;
  let stableSince = Date.now();
  await eventually(async () => {
    const log = events();
    if (count !== log.length) {
      count = log.length;
      stableSince = Date.now();
    }
    assert.ok(log.some((event) => event.event === "ready" && event.options.analysisDebounceMs === 23));
    assert.ok(Date.now() - stableSince > 2000, "restart sequence must settle");
    const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, new vscode.Position(0, 14));
    assert.equal(hover.length, 1, "exactly one provider must remain");
  });
  const active = new Set();
  for (const event of events()) {
    if (event.event === "start") active.add(event.pid);
    if (event.event === "exit") active.delete(event.pid);
    assert.ok(active.size <= 1, `overlapping server processes: ${JSON.stringify(events())}`);
  }
  assert.equal(active.size, 1);
  // Exercise the actual language client's automatic process restart policy.
  const crashed = [...active][0];
  process.kill(crashed, "SIGTERM");
  await eventually(async () => {
    const ready = events()
      .filter((event) => event.event === "ready")
      .at(-1);
    assert.ok(ready && ready.pid !== crashed);
    const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, new vscode.Position(0, 14));
    assert.equal(hover.length, 1);
    assert.ok(
      hover[0].contents.some((content) => content.value === `probe-${ready.pid}`),
      JSON.stringify({ ready, hover }),
    );
  });
  await settings.update("serverPath", "missing-server.cjs", vscode.ConfigurationTarget.Workspace);
  await eventually(() => {
    const remaining = new Set();
    for (const event of events()) {
      if (event.event === "start") remaining.add(event.pid);
      if (event.event === "exit") remaining.delete(event.pid);
    }
    assert.equal(remaining.size, 0, "configuration teardown must stop every owned server");
  });
  writeFileSync(
    process.env.TYPED_SQL_HOST_REPORT,
    JSON.stringify({
      mode: "lifecycle",
      vscode: vscode.version,
      passed: true,
      evidence: "actual-host-controlled-probe",
      checks: ["missing-path-recovery", "overlapping-restarts", "process-crash-recovery", "configuration-teardown"],
    }),
  );
};
