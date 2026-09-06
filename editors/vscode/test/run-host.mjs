import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { grammarCases } from "../../../test/editor-hub/cases.mjs";
import { editCases } from "../../../test/editor-hub/edit-matrix.mjs";
import { buildMatrix, combineHostReports } from "../../../test/editor-hub/matrix.mjs";
import { prepareWorkspace } from "../../../test/editor-hub/workspace.mjs";
import { installPackedServer } from "./packed-install.mjs";
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
  cachePath: join(artifacts, "downloads", "pinned"),
  timeout: 30_000,
});
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
const allScenarios = [
  ...["trusted", "untrusted", "virtual"].map((mode) => ({ mode, id: mode })),
  { mode: "lifecycle", id: "lifecycle" },
  ...grammarCases.map((spec) => ({ mode: "overlays", id: spec.id, spec })),
  ...grammarCases.map((spec) => ({ mode: "extended", id: `${spec.id}-extended`, spec })),
  ...grammarCases.map((spec) => ({ mode: "coexist", id: `${spec.id}-coexist`, spec })),
];
const reports = [];
const selected = process.env.TYPED_SQL_HOST_SCENARIOS?.split(",");
if (selected?.some((id) => !allScenarios.some((scenario) => scenario.id === id)))
  throw new Error("Unknown TYPED_SQL_HOST_SCENARIOS entry");
const scenarios =
  selected === undefined ? allScenarios : allScenarios.filter((scenario) => selected.includes(scenario.id));
const failures = [];
const results = join(artifacts, "results", basename(run));
await mkdir(results, { recursive: true });
const saveMatrices = async () => {
  await writeFile(join(results, "matrix.json"), JSON.stringify(buildMatrix(combineHostReports(reports)), null, 2));
  await writeFile(
    join(results, "edit-matrix.json"),
    JSON.stringify(
      {
        evidence: "actual-host",
        cells: grammarCases.flatMap((spec) =>
          editCases.map((id) => ({
            editor: "vscode",
            grammar: spec.id,
            interface: id,
            ...(reports.find((report) => report.grammar === spec.id && report.editMatrix)?.editMatrix[id] ?? {
              status: "not-run",
            }),
          })),
        ),
      },
      null,
      2,
    ),
  );
};
await saveMatrices();
const packed = await installPackedServer(root, run);
await writeFile(join(results, "packed-install.json"), await readFile(join(run, "packed-install.json")));
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
  const extended = mode === "extended" || mode === "coexist";
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
  if (extended) {
    const server = join(packed, "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js");
    const configure = async (target, grammar) => {
      const settings = await prepareWorkspace(target, root, grammar, packed);
      await mkdir(join(target, ".vscode"), { recursive: true });
      await writeFile(
        join(target, ".vscode/settings.json"),
        JSON.stringify({
          "typedSql.serverPath": server,
          ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [`typedSql.${key}`, value])),
        }),
      );
    };
    await configure(workspace, spec);
    await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }] }));
    const other = grammarCases[(grammarCases.indexOf(spec) + 1) % grammarCases.length];
    const secondary = join(base, "secondary");
    await configure(secondary, other);
    await writeFile(
      join(base, "secondary.json"),
      JSON.stringify({ workspace: secondary, member: other.initial.member, type: other.initial.type }),
    );
  }
  await mkdir(join(profile, "User"), { recursive: true });
  await writeFile(
    join(profile, "User/settings.json"),
    JSON.stringify({
      "security.workspace.trust.startupPrompt": "never",
      "extensions.autoUpdate": false,
      "update.mode": "none",
      "update.enableWindowsBackgroundUpdates": false,
    }),
  );
  const isolated = ["--user-data-dir", profile, "--extensions-dir", extensions];
  const version = (await execFile(cli, [...cliArgs, ...isolated, "--version"], { timeout: 30_000 })).stdout
    .trim()
    .split(/\r?\n/)[0];
  if (version !== "1.134.0")
    throw new Error(
      `VS Code cache version mismatch: expected 1.134.0, got ${version}. Preserve and replace the stale cache before retrying.`,
    );
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
        mode === "virtual" || extended ? workspaceFile : workspace,
        ...isolated,
        "--skip-welcome",
        "--skip-release-notes",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        ...(mode === "coexist" ? [] : ["--disable-extension", "vscode.typescript-language-features"]),
        `--extensionDevelopmentPath=${join(directory, "harness")}`,
        `--extensionTestsPath=${join(directory, extended ? "extended-suite.cjs" : mode === "overlays" ? "overlay-suite.cjs" : mode === "lifecycle" ? "lifecycle-suite.cjs" : "host-suite.cjs")}`,
        ...(mode !== "untrusted" ? ["--disable-workspace-trust"] : []),
      ],
      {
        // Each independent added interface retains its 25-second eventual
        // bound. Allow the complete matrix to report all failures in one host.
        timeout: mode === "extended" ? 420_000 : 90_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          TYPED_SQL_HOST_MODE: mode,
          TYPED_SQL_HOST_GRAMMAR: spec?.id ?? "",
          TYPED_SQL_HOST_MARKER: join(base, "server-started"),
          TYPED_SQL_HOST_PROBE: join(directory, "lifecycle-server.cjs"),
          TYPED_SQL_HOST_REPORT: join(base, "result.json"),
          TYPED_SQL_PACKED_ROOT: packed,
          TYPED_SQL_SECONDARY: join(base, "secondary.json"),
          ...(extended && process.env.TYPED_SQL_HOST_CAPTURE_PREVIEW === "true"
            ? {
                TYPED_SQL_TYPESCRIPT_PREVIEW_CLI: join(directory, "preview-trace.cjs"),
                TYPED_SQL_PREVIEW_TRACE: join(results, `${id}-preview.log`),
              }
            : {}),
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
    // Preserve only this extension's bounded log from the isolated fixture,
    // never the complete editor profile or unrelated extension logs.
    const logs = join(profile, "logs");
    const entries = await readdir(logs, { recursive: true }).catch(() => []);
    report.clientLogs = await Promise.all(
      entries
        .filter((entry) => entry.replaceAll("\\", "/").endsWith("/lojhan.typed-sql/typed-sql.log"))
        .map(async (entry) => (await readFile(join(logs, entry), "utf8")).slice(-32_768)),
    );
  }
  await writeFile(join(results, `${id}.json`), JSON.stringify(report, null, 2));
  if (report.passed !== true) console.error(`Host failure ${id}: ${JSON.stringify(report)}`);
  if (report?.grammar !== undefined) reports.push(report);
  await saveMatrices();
}
console.log(`VS Code host evidence: ${run}`);
if (failures.length > 0) throw new Error(`Host scenarios failed: ${failures.join(", ")}. Evidence: ${results}`);
