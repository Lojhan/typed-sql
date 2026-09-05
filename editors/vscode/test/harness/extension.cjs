const vscode = require("vscode");
const contents = Buffer.from("export const example = 1;\n");
const readonly = () => {
  throw vscode.FileSystemError.NoPermissions();
};
exports.activate = (context) => {
  const changes = new vscode.EventEmitter();
  context.subscriptions.push(
    changes,
    vscode.workspace.registerFileSystemProvider(
      "typed-sql-test",
      {
        onDidChangeFile: changes.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: (uri) => ({
          type: uri.path.endsWith(".ts") ? vscode.FileType.File : vscode.FileType.Directory,
          ctime: 0,
          mtime: 0,
          size: contents.length,
        }),
        readDirectory: () => [["query.ts", vscode.FileType.File]],
        readFile: () => contents,
        writeFile: readonly,
        createDirectory: readonly,
        delete: readonly,
        rename: readonly,
      },
      { isReadonly: true },
    ),
  );
};
