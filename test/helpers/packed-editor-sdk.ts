import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callback);
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
interface SdkLock {
  lock(
    path: string,
    options: {
      realpath: false;
      lockfilePath: string;
      stale: number;
      update: number;
      retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
    },
  ): Promise<() => Promise<void>>;
}
async function outputHash(workspace: string): Promise<string | undefined> {
  const paths = targets.map((target) =>
    join("packages/language-server/sdk", target, target.startsWith("win32") ? "tsc.exe" : "tsc"),
  );
  paths.push("packages/language-server/sdk/GO-LICENSE.txt");
  const hash = createHash("sha256");
  try {
    for (const file of paths) {
      const path = join(workspace, file);
      const handle = await open(path, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0) return undefined;
        hash
          .update(file)
          .update(String(info.mode))
          .update(await handle.readFile());
      } finally {
        await handle.close();
      }
    }
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Coordinate only shared SDK output writes; every consumer still packs and installs afresh. */
export async function ensurePackedEditorSdk(workspace: string): Promise<void> {
  const artifacts = join(workspace, "artifacts");
  await mkdir(artifacts, { recursive: true });
  // proper-lockfile is explicitly resolved from its declaring CLI package, never a hoisted transitive import.
  const { lock } = createRequire(join(workspace, "packages/cli/package.json"))("proper-lockfile") as SdkLock;
  const release = await lock(workspace, {
    realpath: false,
    lockfilePath: join(artifacts, "packed-editor-sdk.lock"),
    stale: 10000,
    update: 2000,
    retries: { retries: 600, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
  try {
    const inputs = createHash("sha256");
    const hashDirectory = async (directory: string): Promise<void> => {
      const entries = await readdir(join(workspace, directory), { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await hashDirectory(file);
        else if (entry.isFile()) inputs.update(file).update(await readFile(join(workspace, file)));
      }
    };
    for (const file of ["scripts/build-editor-sdk.mjs", "packages/ts-bridge/package.json"])
      inputs.update(file).update(await readFile(join(workspace, file)));
    await hashDirectory("tools/editor-sdk");
    const toolchain = (await execFile("go", ["env", "-json"], { cwd: join(workspace, "tools/editor-sdk") })).stdout;
    inputs.update(toolchain);
    const go = JSON.parse(toolchain) as { readonly GOROOT?: unknown };
    if (typeof go.GOROOT !== "string") throw new Error("Go toolchain did not report GOROOT");
    inputs.update(await readFile(join(go.GOROOT, "LICENSE")));
    const input = inputs.digest("hex");
    const receiptFile = join(artifacts, "packed-editor-sdk.json");
    const receipt: unknown = await readFile(receiptFile, "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
        throw error;
      });
    const output = await outputHash(workspace);
    if (
      typeof receipt === "object" &&
      receipt !== null &&
      "input" in receipt &&
      "output" in receipt &&
      receipt.input === input &&
      output !== undefined &&
      receipt.output === output
    )
      return;
    await execFile(process.execPath, [join(workspace, "scripts/build-editor-sdk.mjs"), "--all"], {
      cwd: workspace,
      timeout: 180000,
    });
    const built = await outputHash(workspace);
    if (built === undefined) throw new Error("SDK build did not produce all six executables and the Go license");
    await writeFile(receiptFile, JSON.stringify({ input, output: built }));
  } finally {
    await release();
  }
}
