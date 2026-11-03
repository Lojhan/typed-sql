import { typescriptLanguage } from "@codemirror/lang-javascript";
import { filePathError, validWorkspaceFiles, type WorkspaceFiles } from "./workspace.js";
import { WORKSPACE_CONFIG_NAME, WORKSPACE_CONFIG_PATH } from "./workspace-ui.js";

export function containsPath(parent: string, path: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}
export function workspaceFolders(files: readonly string[], folders: readonly string[]): string[] {
  const paths = new Set(folders);
  for (const path of [...files, ...folders]) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) paths.add(parts.slice(0, index).join("/"));
  }
  return [...paths].sort();
}
export function folderPathError(path: string): string | undefined {
  return filePathError(`${path}/file.ts`) ? "Use a relative folder path, such as queries/reports." : undefined;
}
export function validWorkspaceFolders(value: unknown, files: WorkspaceFiles): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 80 &&
    value.every(
      (path) =>
        typeof path === "string" &&
        !folderPathError(path) &&
        path !== WORKSPACE_CONFIG_NAME &&
        !path.startsWith(`${WORKSPACE_CONFIG_NAME}/`) &&
        !Object.keys(files).some((file) => containsPath(file, path)),
    )
  );
}
export function entryPathError(
  files: WorkspaceFiles,
  folders: readonly string[],
  path: string,
  folder: boolean,
  from?: string,
): string | undefined {
  if (path === WORKSPACE_CONFIG_NAME || path === WORKSPACE_CONFIG_PATH || path.startsWith(`${WORKSPACE_CONFIG_NAME}/`))
    return "This name is reserved for the read-only playground config.";
  const invalid = folder ? folderPathError(path) : filePathError(path);
  if (invalid) return invalid;
  if (from === path) return;
  if (from && folder && containsPath(from, path)) return "A folder cannot be moved inside itself.";
  const remainingFiles = Object.keys(files).filter((file) => !from || !containsPath(from, file));
  const remainingFolders = workspaceFolders(Object.keys(files), folders).filter(
    (dir) => !from || !containsPath(from, dir),
  );
  if (
    remainingFiles.some((file) => containsPath(file, path) || containsPath(path, file)) ||
    remainingFolders.includes(path) ||
    (!folder && remainingFolders.some((dir) => containsPath(path, dir)))
  )
    return "A file or folder with this path already exists.";
  if (
    workspaceFolders([...remainingFiles, ...(folder ? [] : [path])], [...remainingFolders, ...(folder ? [path] : [])])
      .length > 80
  )
    return "The playground supports up to 80 folders.";
}
function resolve(from: string, specifier: string): string | undefined {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      if (!parts.length) return;
      parts.pop();
    } else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}
function relative(from: string, target: string): string {
  const source = from.split("/").slice(0, -1);
  const dest = target.split("/");
  while (source.length && source[0] === dest[0]) {
    source.shift();
    dest.shift();
  }
  const path = [...source.map(() => ".."), ...dest].join("/");
  return path.startsWith(".") ? path : `./${path}`;
}
export function renameWorkspaceEntry(
  files: WorkspaceFiles,
  folders: readonly string[],
  from: string,
  to: string,
  folder: boolean,
) {
  const error = entryPathError(files, folders, to, folder, from);
  if (error) throw new Error(error);
  if (from === WORKSPACE_CONFIG_PATH || from === WORKSPACE_CONFIG_NAME)
    throw new Error("The playground configuration is read only.");
  if (folder ? !workspaceFolders(Object.keys(files), folders).includes(from) : !Object.hasOwn(files, from))
    throw new Error("This file or folder no longer exists.");
  const mapped = (path: string) => (containsPath(from, path) ? `${to}${path.slice(from.length)}` : path);
  const updated: WorkspaceFiles = {};
  for (const [path, source] of Object.entries(files)) {
    const nextPath = mapped(path);
    const edits: { from: number; to: number; text: string }[] = [];
    if (path.endsWith(".ts"))
      typescriptLanguage.parser.parse(source).iterate({
        enter(node) {
          if (
            node.name !== "String" ||
            !["ImportDeclaration", "ExportDeclaration", "DynamicImport"].includes(node.node.parent?.name ?? "")
          )
            return;
          const specifier = source.slice(node.from + 1, node.to - 1);
          if (!specifier.startsWith(".") || specifier.includes("\\")) return;
          const resolved = resolve(path, specifier);
          const target = [resolved, `${resolved}.ts`, `${resolved}/index.ts`, resolved?.replace(/\.js$/u, ".ts")].find(
            (candidate) => candidate !== undefined && Object.hasOwn(files, candidate),
          );
          if (!target || (nextPath === path && mapped(target) === target)) return;
          let replacement = relative(nextPath, mapped(target));
          if (!/\.(ts|sql|js)$/u.test(specifier)) replacement = replacement.replace(/\.ts$/u, "");
          else if (specifier.endsWith(".js")) replacement = replacement.replace(/\.ts$/u, ".js");
          edits.push({ from: node.from + 1, to: node.to - 1, text: replacement });
        },
      });
    let content = source;
    for (const edit of edits.reverse()) content = content.slice(0, edit.from) + edit.text + content.slice(edit.to);
    updated[nextPath] = content;
  }
  if (!validWorkspaceFiles(updated)) throw new Error("The renamed workspace exceeds its size limits.");
  return {
    files: updated,
    folders: workspaceFolders(Object.keys(updated), workspaceFolders(Object.keys(files), folders).map(mapped)),
    mapped,
  };
}

export const TREE_ENTRY_MIME = "application/x-typed-sql-tree-entry";
export interface TreeDragEntry {
  path: string;
  folder: boolean;
}
export function treeMoveDestination(
  files: WorkspaceFiles,
  folders: readonly string[],
  entry: TreeDragEntry,
  parent: string,
): { path?: string; error?: string } {
  if (entry.path === WORKSPACE_CONFIG_PATH || entry.path === WORKSPACE_CONFIG_NAME)
    return { error: "The playground configuration is read only." };
  if (
    entry.folder
      ? !workspaceFolders(Object.keys(files), folders).includes(entry.path)
      : !Object.hasOwn(files, entry.path)
  )
    return { error: "This file or folder no longer exists." };
  if (parent && !workspaceFolders(Object.keys(files), folders).includes(parent))
    return { error: "The destination folder no longer exists." };
  const path = [parent, entry.path.split("/").pop()].filter(Boolean).join("/");
  if (path === entry.path) return {};
  const error = entryPathError(files, folders, path, entry.folder, entry.path);
  return error ? { error } : { path };
}
