import { resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { API, Snapshot } from "typescript/unstable/async";

const input = workerData as {
  readonly apiUrl: string;
  readonly cwd: string;
  readonly project: string;
  readonly file?: string;
  readonly virtualProject?: string;
  readonly files: Readonly<Record<string, string>>;
};
const { API: NativeAPI } = (await import(input.apiUrl)) as { API: typeof API };
let changed: string | undefined;
const api = new NativeAPI({
  cwd: input.cwd,
  fs: {
    fileExists: (file) => (file === input.virtualProject ? true : undefined),
    readFile(file) {
      if (file === input.virtualProject)
        return JSON.stringify({
          extends: input.project,
          compilerOptions: {
            composite: false,
            declaration: false,
            declarationMap: false,
            incremental: false,
            noEmit: true,
          },
          files: [input.file],
          include: [],
        });
      const key = resolve(file);
      if (Object.hasOwn(input.files, key)) return input.files[key];
      if (
        !file.split(/[\\/]/u).includes("node_modules") &&
        !/\.d\.[cm]?ts$/u.test(file) &&
        /\.[cm]?[jt]sx?$/u.test(file)
      ) {
        changed = file;
        return null;
      }
      return undefined;
    },
  },
});
let snapshot: Snapshot | undefined;
let result: { diagnostics?: readonly import("typescript/unstable/async").Diagnostic[]; error?: string };
try {
  snapshot = await api.updateSnapshot({ openProjects: [input.virtualProject ?? input.project] });
  const project = snapshot.getProject(input.virtualProject ?? input.project);
  if (project === undefined) throw new Error(`Could not load TypeScript project ${input.project}`);
  const program = project.program;
  const diagnostics = [
    ...(await program.getConfigFileParsingDiagnostics()),
    ...(await program.getProgramDiagnostics()),
    ...(await program.getGlobalDiagnostics()),
    ...(await program.getSyntacticDiagnostics()),
    ...(await program.getBindDiagnostics()),
    ...(await program.getSemanticDiagnostics()),
  ];
  if (changed !== undefined) throw new Error(`Project inputs changed during checking: ${changed}. Retry the check.`);
  result = { diagnostics };
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) };
} finally {
  await snapshot?.dispose();
  await api.close();
}

parentPort!.postMessage(result);
parentPort!.close();
