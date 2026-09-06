const assert = require("node:assert/strict");
const { readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { join, relative, isAbsolute } = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const { grammarCases, sourceFor } = await import("../../../test/editor-hub/cases.mjs");
  const { pendingInterfaces } = await import("../../../test/editor-hub/matrix.mjs");
  const { editCases } = await import("../../../test/editor-hub/edit-matrix.mjs");
  const { runExtendedScenario } = await import("../../../test/editor-hub/extended-scenario.mjs");
  const spec = grammarCases.find((item) => item.id === process.env.TYPED_SQL_HOST_GRAMMAR);
  assert.ok(spec);
  const coexist = process.env.TYPED_SQL_HOST_MODE === "coexist";
  const owned = coexist ? ["builtin-coexistence"] : pendingInterfaces.filter((id) => id !== "builtin-coexistence");
  const report = {
    editor: "vscode",
    grammar: spec.id,
    mode: coexist ? "coexist" : "extended",
    vscode: vscode.version,
    evidence: "actual-host",
    passed: false,
    checks: Object.fromEntries(owned.map((id) => [id, { status: "not-run" }])),
    editMatrix: coexist ? {} : Object.fromEntries(editCases.map((id) => [id, { status: "not-run" }])),
  };
  const save = () => writeFileSync(process.env.TYPED_SQL_HOST_REPORT, JSON.stringify(report));
  save();
  const root = vscode.workspace.workspaceFolders[0].uri;
  const primary = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "query.ts"));
  let document = primary;
  const tracked = new Map([[primary.uri.toString(), primary]]);
  const position = (doc, needle, amount = 0) => {
    const index = doc.getText().indexOf(needle);
    assert.notEqual(index, -1, needle);
    return doc.positionAt(index + amount);
  };
  const fullRange = (doc) => new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const replace = async (doc, text) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange(doc), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(doc.getText(), text);
  };
  const open = async (name, text) => {
    const uri = vscode.Uri.joinPath(root, name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
    const doc = await vscode.workspace.openTextDocument(uri);
    await replace(doc, text);
    tracked.set(uri.toString(), doc);
    return doc;
  };
  const hover = async (doc, needle, amount = 0) => {
    const result = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      doc.uri,
      position(doc, needle, amount),
    );
    return (result ?? []).flatMap((item) => item.contents.map((content) => content.value ?? content)).join("\n");
  };
  const serialRange = (range) => ({
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  });
  const editsFor = (edit) => {
    assert.ok(edit && typeof edit.entries === "function", "workspace edit required");
    const entries = edit.entries();
    assert.equal(entries.reduce((count, [, edits]) => count + edits.length, 0) > 0, true);
    return Object.fromEntries(
      entries.map(([uri, edits]) => [
        uri.toString(),
        edits.map((item) => ({ range: serialRange(item.range), newText: item.newText })),
      ]),
    );
  };
  const host = {
    async reset(source) {
      for (const doc of tracked.values()) if (doc !== primary) await replace(doc, "");
      tracked.clear();
      tracked.set(primary.uri.toString(), primary);
      document = primary;
      await replace(primary, source);
      await vscode.window.showTextDocument(primary);
    },
    hover: (needle, amount) => hover(document, needle, amount),
    async sources() {
      return Object.fromEntries([...tracked].map(([uri, doc]) => [uri, doc.getText()]));
    },
    async completions(needle, amount) {
      const result = await vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        document.uri,
        position(document, needle, amount),
      );
      return (result?.items ?? []).map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    },
    async diagnostics() {
      return vscode.languages.getDiagnostics(document.uri).map((item) => ({
        line: item.range.start.line,
        error: item.severity === vscode.DiagnosticSeverity.Error,
        message: item.message,
        source: item.source,
        code: typeof item.code === "object" ? item.code.value : item.code,
      }));
    },
    async crossFile(source) {
      await this.reset(`${source}\nexport const sharedValue = 1; void sharedValue;\n`);
      const other = await open(
        "consumer.ts",
        `${source}\nimport { sharedValue } from "./query.js"; void sharedValue;\n`,
      );
      await vscode.window.showTextDocument(other);
      await hover(other, "void sharedValue", "void ".length);
      await vscode.window.showTextDocument(primary);
      return this.sources();
    },
    async references(symbol) {
      return (
        (await vscode.commands.executeCommand(
          "vscode.executeReferenceProvider",
          document.uri,
          position(document, symbol),
        )) ?? []
      ).map((item) => ({ uri: item.uri.toString(), range: serialRange(item.range) }));
    },
    locationOrder: (a, b) =>
      a.uri.localeCompare(b.uri) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
    occurrences(texts, symbol) {
      return Object.entries(texts).flatMap(([uri, text]) =>
        [...text.matchAll(new RegExp(`\\b${symbol}\\b`, "g"))].map((match) => {
          const doc = tracked.get(uri);
          return {
            uri,
            range: serialRange(
              new vscode.Range(doc.positionAt(match.index), doc.positionAt(match.index + symbol.length)),
            ),
          };
        }),
      );
    },
    async rename(symbol, replacement) {
      return editsFor(
        await vscode.commands.executeCommand(
          "vscode.executeDocumentRenameProvider",
          document.uri,
          position(document, symbol),
          replacement,
        ),
      );
    },
    async apply(edits, before, after) {
      const operation = new vscode.WorkspaceEdit();
      for (const [uri, text] of Object.entries(before))
        assert.equal(tracked.get(uri).getText(), text, "reject stale source snapshots before applying edits");
      for (const [uri, changes] of Object.entries(edits))
        for (const change of changes)
          operation.replace(
            vscode.Uri.parse(uri),
            new vscode.Range(
              change.range.start.line,
              change.range.start.character,
              change.range.end.line,
              change.range.end.character,
            ),
            change.newText,
          );
      assert.equal(await vscode.workspace.applyEdit(operation), true);
      for (const [uri, text] of Object.entries(after))
        assert.equal(tracked.get(uri).getText(), text, "editor must apply exactly the validated source edits");
    },
    async format(ranged) {
      const options = { tabSize: 2, insertSpaces: true };
      const edits = await vscode.commands.executeCommand(
        ranged ? "vscode.executeFormatRangeProvider" : "vscode.executeFormatDocumentProvider",
        document.uri,
        ...(ranged
          ? [
              new vscode.Range(
                position(document, "export const unformatted"),
                document.positionAt(document.getText().length),
              ),
            ]
          : []),
        options,
      );
      // VS Code returns undefined when an already formatted document needs no
      // edits. The shared scenario separately requires meaningful first-pass edits.
      assert.ok(edits === undefined || Array.isArray(edits), "unexpected formatter response");
      return {
        [document.uri.toString()]: (edits ?? []).map((item) => ({
          range: serialRange(item.range),
          newText: item.newText,
        })),
      };
    },
    async codeActions() {
      const actions = await vscode.commands.executeCommand(
        "vscode.executeCodeActionProvider",
        document.uri,
        fullRange(document),
        vscode.CodeActionKind.QuickFix.value,
        20,
      );
      return (actions ?? []).map((item) => ({ title: item.title, edits: item.edit ? editsFor(item.edit) : undefined }));
    },
    async semanticTokens(ranged) {
      const result = await vscode.commands.executeCommand(
        ranged ? "vscode.provideDocumentRangeSemanticTokens" : "vscode.provideDocumentSemanticTokens",
        document.uri,
        ...(ranged ? [fullRange(document)] : []),
      );
      assert.ok(result?.data, "semantic token provider required");
      const data = result.data;
      assert.equal(data.length % 5, 0);
      let line = 0;
      let character = 0;
      const tokens = [];
      for (let index = 0; index < data.length; index += 5) {
        line += data[index];
        character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
        assert.ok(line < document.lineCount);
        const length = data[index + 2];
        assert.ok(character + length <= document.lineAt(line).text.length, "token outside original source");
        tokens.push({ text: document.lineAt(line).text.slice(character, character + length), length });
      }
      return tokens;
    },
    async openTsx(source) {
      document = await open("view.tsx", source);
      await vscode.window.showTextDocument(document);
    },
    async restart() {
      const settings = vscode.workspace.getConfiguration("typedSql", root);
      const server = settings.get("serverPath");
      try {
        await settings.update("serverPath", "missing-restart-server.cjs", vscode.ConfigurationTarget.WorkspaceFolder);
        const deadline = Date.now() + 25_000;
        let stopped = false;
        do {
          const value = await hover(document, "return row.", "return row.".length).catch(() => "");
          if (value === "") {
            stopped = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.ok(stopped, "old server providers must stop before restart");
        assert.equal(document.isDirty, true, "restart must replay unsaved SQL");
      } finally {
        await settings.update("serverPath", server, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    },
    async multiRoot(verify) {
      const prepared = JSON.parse(readFileSync(process.env.TYPED_SQL_SECONDARY, "utf8"));
      const uri = vscode.Uri.file(prepared.workspace);
      assert.equal(vscode.workspace.updateWorkspaceFolders(1, 0, { uri, name: "other-grammar" }), true);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(uri, "query.ts"));
        await vscode.window.showTextDocument(doc);
        await verify({
          member: prepared.member,
          type: prepared.type,
          hover: () => hover(doc, `return row.${prepared.member}`, "return row.".length),
        });
      } finally {
        const index = vscode.workspace.workspaceFolders.findIndex((folder) => folder.uri.toString() === uri.toString());
        if (index >= 0) assert.equal(vscode.workspace.updateWorkspaceFolders(index, 1), true);
        await vscode.window.showTextDocument(primary);
      }
    },
    async verifyPacked() {
      const consumer = realpathSync(process.env.TYPED_SQL_PACKED_ROOT);
      for (const name of ["@typed-sql/core", spec.packageName, "@typed-sql/language-server"]) {
        const resolved = realpathSync(join(consumer, "node_modules", name));
        const owned = relative(consumer, resolved);
        assert.ok(
          !owned.startsWith("..") && !isAbsolute(owned),
          `package must resolve inside isolated install: ${resolved}`,
        );
      }
      const configured = vscode.workspace.getConfiguration("typedSql", root).get("serverPath");
      assert.ok(realpathSync(configured).startsWith(`${consumer}/`), "host must run installed server artifact");
    },
  };
  await vscode.window.showTextDocument(primary);
  const extension = vscode.extensions.getExtension("lojhan.typed-sql");
  assert.ok(extension);
  await extension.activate();
  if (coexist) {
    try {
      const builtin = vscode.extensions.getExtension("vscode.typescript-language-features");
      assert.ok(builtin);
      await builtin.activate();
      await host.reset(sourceFor(spec));
      const deadline = Date.now() + 25_000;
      let observed;
      do {
        observed = await host.hover(`return row.${spec.initial.member}`, "return row.".length);
        if (observed.includes(spec.initial.member) && !/\b(any|unknown)\b/.test(observed)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      assert.ok(observed.includes(spec.initial.member), observed);
      assert.doesNotMatch(observed, /\b(any|unknown)\b/);
      assert.match(await host.hover("ordinary.count", "ordinary.".length), /number/);
      const errors = await host.diagnostics();
      assert.ok(!errors.some((item) => item.error && item.line === 6), JSON.stringify(errors));
      report.checks["builtin-coexistence"] = { status: "passed" };
    } catch (error) {
      report.checks["builtin-coexistence"] = { status: "failed", error: String(error.stack ?? error) };
    }
    save();
  } else {
    assert.equal(vscode.extensions.getExtension("vscode.typescript-language-features"), undefined);
    await runExtendedScenario(
      spec,
      host,
      (id, status, error) => {
        report.checks[id] = { status, ...(error ? { error } : {}) };
        save();
      },
      (id, status, error) => {
        report.editMatrix[id] = { status, ...(error ? { error } : {}) };
        save();
      },
    );
  }
  report.passed =
    Object.values(report.checks).every((item) => item.status === "passed") &&
    Object.values(report.editMatrix).every((item) => item.status === "passed");
  save();
  assert.equal(report.passed, true, JSON.stringify(report));
};
