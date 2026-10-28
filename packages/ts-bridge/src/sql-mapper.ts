// Official TypeScript 7.1 content-mapper protocol:
// https://github.com/microsoft/typescript-go/pull/4712 (updated by microsoft/TypeScript#63936).
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { createMessageConnection, NullLogger } from "vscode-jsonrpc/node";
import { analyzeSqlFile, loadSqlFileProject, type SqlFileProject } from "./sql-file.js";

const projects = new Map<string, SqlFileProject | { readonly error: string }>();
const connection = createMessageConnection(stdin, stdout, NullLogger);
connection.onRequest("initialize", (params: { readonly positionEncodings: readonly string[] }) => {
  if (!params.positionEncodings.includes("utf-16")) throw new Error("typed-sql requires UTF-16 position encoding");
  return { positionEncoding: "utf-16", diagnosticSource: "typed-sql" };
});
connection.onRequest(
  "openProject",
  async (params: {
    readonly projectHandle: string;
    readonly configFileName: string;
    readonly compilerOptions: { readonly noEmit?: boolean };
    readonly options?: { readonly config?: unknown };
  }): Promise<{
    configIdentity: string;
    watchedFiles?: readonly string[];
    optionDiagnostics?: readonly { path: readonly (string | number)[]; code: number; messageText: string }[];
  }> => {
    projects.delete(params.projectHandle);
    if (params.compilerOptions.noEmit !== true) {
      projects.set(params.projectHandle, {
        error:
          "The typed-sql SQL-file frontend requires noEmit: true; use the Node.js 24 SQL loader for runtime imports.",
      });
      return {
        configIdentity: "unsupported-emit",
      };
    }
    if (params.options?.config !== undefined && typeof params.options.config !== "string") {
      return {
        configIdentity: "invalid",
        optionDiagnostics: [{ path: ["config"], code: 901, messageText: "config must be a path string" }],
      };
    }
    const project = await loadSqlFileProject(
      params.configFileName === "" ? process.cwd() : dirname(params.configFileName),
      params.options?.config,
    );
    projects.set(params.projectHandle, project);
    return { configIdentity: project.configIdentity, watchedFiles: project.watchedFiles };
  },
);
connection.onRequest(
  "transform",
  (params: { readonly projectHandle: string; readonly fileName: string; readonly content: string }) => {
    const project = projects.get(params.projectHandle);
    if (project === undefined) throw new Error("SQL mapper project is not open");
    if ("error" in project)
      return {
        text: "declare const query: never; export default query;",
        extension: ".ts",
        diagnostics: [{ messageText: project.error, code: 901, start: 0, length: Math.min(params.content.length, 1) }],
      };
    const { runtime: _runtime, ...result } = analyzeSqlFile(params.content, project);
    return result;
  },
);
connection.onRequest("closeProject", (params: { readonly projectHandle: string }) => {
  projects.delete(params.projectHandle);
  return null;
});
connection.listen();
