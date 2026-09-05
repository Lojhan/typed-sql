import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { grammarCases } from "../../../test/editor-hub/cases.mjs";
import { buildMatrix } from "../../../test/editor-hub/matrix.mjs";
import { prepareOverlayWorkspace } from "./setup-overlays.mjs";

const execFile = promisify(execFileCallback);
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const artifacts = join(root, "artifacts/editor-host");
await mkdir(artifacts, { recursive: true });
const dataRoot = resolve(process.env.TYPED_SQL_HOST_DATA_ROOT ?? artifacts);
await mkdir(dataRoot, { recursive: true });
const run = await mkdtemp(join(dataRoot, "v-"));
const executable = await downloadAndUnzipVSCode({
  version: "1.134.0",
  cachePath: join(artifacts, "downloads"),
  timeout: 30_000,
});
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
const scenarios = [
  ...["trusted", "untrusted", "virtual"].map((mode) => ({ mode, id: mode })),
  { mode: "lifecycle", id: "lifecycle" },
  ...grammarCases.map((spec) => ({ mode: "overlays", id: spec.id, spec })),
];
const reports = [];
const failures = [];
const results = join(artifacts, "results", basename(run));
await mkdir(results, { recursive: true });
await writeFile(join(results, "matrix.json"), JSON.stringify(buildMatrix(reports), null, 2));
for (const [index, { mode, id, spec }] of scenarios.entries()) {
  const base = join(run, String(index));
  const workspace = join(base, "workspace");
  const profile = join(base, "p");
  if (process.platform !== "win32" && Buffer.byteLength(join(profile, "1.134-main.sock")) > 100) {
    throw new Error(
      "Set TYPED_SQL_HOST_DATA_ROOT to a shorter directory for editor IPC sockets (not a system temporary directory).",
    );
  }
  const extensions = join(base, "extensions");
  await mkdir(join(workspace, ".vscode"), { recursive: true });
  await writeFile(join(workspace, "query.ts"), "export const example = 1;\n");
  const workspaceFile = join(base, "virtual.code-workspace");
  if (mode === "virtual")
    await writeFile(
      workspaceFile,
      JSON.stringify({
        folders: [{ uri: "typed-sql-test:/workspace" }],
        settings: { "typedSql.serverPath": join(directory, "probe-server.cjs") },
      }),
    );
  await writeFile(
    join(workspace, ".vscode/settings.json"),
    JSON.stringify({
      "typedSql.serverPath": mode === "lifecycle" ? "missing-server.cjs" : join(directory, "probe-server.cjs"),
    }),
  );
  if (mode === "overlays") await prepareOverlayWorkspace(workspace, root, spec);
  await mkdir(join(profile, "User"), { recursive: true });
  await writeFile(
    join(profile, "User/settings.json"),
    JSON.stringify({ "security.workspace.trust.startupPrompt": "never", "extensions.autoUpdate": false }),
  );
  const isolated = ["--user-data-dir", profile, "--extensions-dir", extensions];
  await execFile(cli, [...cliArgs, ...isolated, "--install-extension", join(root, "artifacts/typed-sql-vscode.vsix")], {
    timeout: 60_000,
  });
  // test-electron's runTests adds --disable-workspace-trust unconditionally.
  // Launch the documented extension-test entrypoint directly so Restricted Mode
  // is genuinely exercised, rather than accidentally testing two trusted hosts.
  let failure;
  try {
    await execFile(
      executable,
      [
        mode === "virtual" ? workspaceFile : workspace,
        ...isolated,
        "--skip-welcome",
        "--skip-release-notes",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        "--disable-extension",
        "vscode.typescript-language-features",
        `--extensionDevelopmentPath=${join(directory, "harness")}`,
        `--extensionTestsPath=${join(directory, mode === "overlays" ? "overlay-suite.cjs" : mode === "lifecycle" ? "lifecycle-suite.cjs" : "host-suite.cjs")}`,
        ...(mode !== "untrusted" ? ["--disable-workspace-trust"] : []),
      ],
      {
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          TYPED_SQL_HOST_MODE: mode,
          TYPED_SQL_HOST_GRAMMAR: spec?.id ?? "",
          TYPED_SQL_HOST_MARKER: join(base, "server-started"),
          TYPED_SQL_HOST_PROBE: join(directory, "lifecycle-server.cjs"),
          TYPED_SQL_HOST_REPORT: join(base, "result.json"),
        },
      },
    );
  } catch (error) {
    failure = error;
    failures.push(id);
  }
  let report;
  try {
    report = JSON.parse(await readFile(join(base, "result.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (failure !== undefined || report?.passed !== true) {
    if (!failures.includes(id)) failures.push(id);
    report = {
      ...report,
      passed: false,
      hostError: String(failure ?? "Host did not write a passing report").slice(0, 4000),
    };
  }
  await writeFile(join(results, `${id}.json`), JSON.stringify(report, null, 2));
  if (report.passed !== true) console.error(`Host failure ${id}: ${JSON.stringify(report)}`);
  if (report?.grammar !== undefined) reports.push(report);
  await writeFile(join(results, "matrix.json"), JSON.stringify(buildMatrix(reports), null, 2));
}
console.log(`VS Code host evidence: ${run}`);
if (failures.length > 0) throw new Error(`Host scenarios failed: ${failures.join(", ")}. Evidence: ${results}`);
