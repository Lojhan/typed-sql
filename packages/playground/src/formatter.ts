import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { contentHash, WorkspaceError, type WorkspaceFiles } from "./files.js";

type Formatter = "biome" | "prettier";
interface Configuration {
  formatter: Formatter;
  path: string;
  revision: string;
}
export interface FormatResult {
  readonly file: string;
  readonly source: string;
  /** The saved revision remains unchanged; formatting only returns a buffer. */
  readonly revision: string;
  readonly formatter: Formatter;
  readonly config: string;
}
const maxBytes = 512 * 1024;
const prettierNames = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".prettierrc.cts",
  ".prettierrc.mts",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
  "prettier.config.cts",
  "prettier.config.mts",
];
const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function boundedRead(path: string): Promise<string> {
  const handle = await open(
    await realpath(path),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat(),
      limit = 1024 * 1024;
    if (!info.isFile() || info.size > limit)
      throw new WorkspaceError(
        "FORMATTER_CONFIG",
        "Formatter metadata/config must be an ordinary file no larger than 1 MiB",
      );
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new WorkspaceError("FORMATTER_CONFIG", "Formatter metadata/config exceeds 1 MiB");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } catch {
      throw new WorkspaceError("FORMATTER_CONFIG", "Formatter configuration contains invalid UTF-8");
    }
  } finally {
    await handle.close();
  }
}
async function repositoryBoundary(root: string): Promise<string> {
  for (let directory = root; ; directory = dirname(directory)) {
    if (await exists(join(directory, ".git"))) return directory;
    if (dirname(directory) === directory) return root;
  }
}
async function configuration(file: string, root: string, only?: Formatter): Promise<Configuration> {
  const boundary = await repositoryBoundary(root);
  for (let directory = dirname(file); within(boundary, directory); directory = dirname(directory)) {
    for (const [formatter, names] of [
      ["biome", ["biome.json", "biome.jsonc"]],
      ["prettier", prettierNames],
    ] as const) {
      if (only && formatter !== only) continue;
      for (const name of names) {
        const path = join(directory, name);
        if (!(await exists(path))) continue;
        if (!within(await realpath(boundary), await realpath(path)))
          throw new WorkspaceError(
            "FORMATTER_CONFIG",
            "Formatter configuration must remain within the repository",
            403,
          );
        return { formatter, path, revision: contentHash(await boundedRead(path)) };
      }
    }
    const pkg = join(directory, "package.json");
    if (only !== "biome" && (await exists(pkg))) {
      if (!within(await realpath(boundary), await realpath(pkg)))
        throw new WorkspaceError("FORMATTER_CONFIG", "Formatter configuration must remain within the repository", 403);
      let metadata: unknown;
      try {
        metadata = JSON.parse(await boundedRead(pkg));
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError(
          "FORMATTER_CONFIG",
          "Cannot read repository package.json while discovering formatter configuration",
        );
      }
      if (metadata && typeof metadata === "object" && Object.hasOwn(metadata, "prettier"))
        return { formatter: "prettier", path: pkg, revision: contentHash(await boundedRead(pkg)) };
    }
    if (directory === boundary) break;
  }
  throw new WorkspaceError(
    only ? "FORMATTER_NO_FALLBACK" : "FORMATTER_CONFIG",
    "No repository Biome or Prettier configuration was found. Add a formatter configuration and install its package locally.",
  );
}
async function executable(formatter: Formatter, from: string, boundary: string): Promise<string> {
  const name = formatter === "biome" ? "@biomejs/biome" : "prettier";
  for (let directory = dirname(from); ; directory = dirname(directory)) {
    const packageRoot = join(directory, "node_modules", name),
      metadataPath = join(packageRoot, "package.json");
    if (await exists(metadataPath)) {
      let metadata: { name?: unknown; bin?: unknown };
      try {
        metadata = JSON.parse(await boundedRead(metadataPath)) as typeof metadata;
      } catch {
        throw new WorkspaceError("FORMATTER_INSTALL", `Cannot read the installed ${name} package metadata`);
      }
      const bin =
        typeof metadata.bin === "string"
          ? metadata.bin
          : metadata.bin && typeof metadata.bin === "object"
            ? (metadata.bin as Record<string, unknown>)[formatter]
            : undefined;
      if (
        metadata.name !== name ||
        typeof bin !== "string" ||
        isAbsolute(bin) ||
        !within(resolve(packageRoot), resolve(packageRoot, bin))
      )
        throw new WorkspaceError("FORMATTER_INSTALL", `The project-local ${name} package has no valid formatter CLI`);
      const path = resolve(packageRoot, bin);
      if (!(await exists(path)))
        throw new WorkspaceError(
          "FORMATTER_INSTALL",
          `The installed ${name} CLI is missing; reinstall that repository dependency`,
        );
      return path;
    }
    if (directory === boundary || dirname(directory) === directory) break;
  }
  throw new WorkspaceError(
    "FORMATTER_INSTALL",
    `Install ${name} in this project or its workspace. The playground does not install formatters or use global executables.`,
  );
}
function terminate(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      /* Process may already have exited. */
    }
  }
  child.kill("SIGKILL");
}

/** Executes only known local formatter CLIs, after trust and revision checks. Never writes source files. */
export class WorkspaceFormatter {
  private readonly children = new Set<ChildProcess>();
  private active = 0;
  private closed = false;
  constructor(
    private readonly files: WorkspaceFiles,
    private readonly timeoutMs = 5000,
  ) {}
  async format(request: { file: string; source: string; revision: string }, trusted: boolean): Promise<FormatResult> {
    if (!trusted)
      throw new WorkspaceError("TRUST", "Enable trusted project execution before running repository formatters", 403);
    if (this.closed) throw new WorkspaceError("FORMATTER_CLOSED", "The workspace formatter is closed", 503);
    if (this.active >= 2)
      throw new WorkspaceError("FORMATTER_BUSY", "Two formatting operations are already running. Wait and retry.", 429);
    if (Buffer.byteLength(request.source) > maxBytes)
      throw new WorkspaceError("FILE_LIMIT", "Formatting input exceeds the 512 KiB editor limit", 413);
    if (Buffer.from(request.source, "utf8").toString("utf8") !== request.source)
      throw new WorkspaceError(
        "FORMATTER_ENCODING",
        "The buffer contains invalid Unicode. Correct it before formatting.",
      );
    this.active++;
    try {
      const file = await this.files.path(request.file, true);
      await this.revision(request.file, request.revision);
      const deadline = Date.now() + this.timeoutMs;
      const boundary = await repositoryBoundary(this.files.root);
      let config = await configuration(file, this.files.root);
      const used = [config];
      let source: string;
      try {
        source = await this.formatConfigured(config, file, request.source, boundary, deadline);
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "FORMATTER_DISABLED" || config.formatter !== "biome")
          throw error;
        try {
          config = await configuration(file, this.files.root, "prettier");
        } catch (fallback) {
          if (fallback instanceof WorkspaceError && fallback.code === "FORMATTER_NO_FALLBACK") throw error;
          throw fallback;
        }
        used.push(config);
        source = await this.formatConfigured(config, file, request.source, boundary, deadline);
      }
      if (request.source.trim() && !source.trim())
        throw new WorkspaceError(
          "FORMATTER_EMPTY",
          "The repository formatter returned empty output for a nonempty buffer. No changes were applied.",
        );
      await this.files.path(request.file, true);
      await this.revision(request.file, request.revision);
      for (const configuration of used)
        if (contentHash(await boundedRead(configuration.path)) !== configuration.revision)
          throw new WorkspaceError(
            "FORMATTER_CONFIG_CHANGED",
            "Formatter configuration changed while formatting. Retry with the current configuration.",
            409,
          );
      return {
        file: request.file,
        source,
        revision: request.revision,
        formatter: config.formatter,
        config: relative(this.files.root, config.path).split(sep).join("/"),
      };
    } finally {
      this.active--;
    }
  }
  private async formatConfigured(
    config: Configuration,
    file: string,
    input: string,
    boundary: string,
    deadline: number,
  ): Promise<string> {
    const cli = await executable(config.formatter, file, boundary);
    const args =
      config.formatter === "biome"
        ? [
            "format",
            `--stdin-file-path=${file}`,
            `--config-path=${config.path}`,
            "--colors=off",
            "--files-ignore-unknown=false",
          ]
        : ["--stdin-filepath", file, "--config", config.path];
    if (config.formatter === "prettier") {
      const ignores: string[] = [];
      for (let directory = dirname(file); within(boundary, directory); directory = dirname(directory)) {
        for (const name of [".prettierignore", ".gitignore"]) {
          const path = join(directory, name);
          if (await exists(path)) ignores.push("--ignore-path", path);
        }
        if (directory === boundary) break;
      }
      args.push(...ignores);
      const infoText = await this.execute(
        cli,
        ["--file-info", file, "--config", config.path, ...ignores],
        dirname(config.path),
        config.formatter,
        "",
        false,
        deadline,
      );
      let info: unknown;
      try {
        info = JSON.parse(infoText);
      } catch {
        throw new WorkspaceError("FORMATTER_FAILED", "The installed Prettier CLI returned invalid file information");
      }
      if (info && typeof info === "object" && "ignored" in info && info.ignored === true)
        throw new WorkspaceError("FORMATTER_IGNORED", "Prettier ignores this file under the repository ignore rules");
    }
    return this.execute(cli, args, dirname(config.path), config.formatter, input, file.endsWith(".sql"), deadline);
  }
  private async revision(file: string, revision: string) {
    if ((await this.files.read(file)).revision !== revision)
      throw new WorkspaceError("FILE_CONFLICT", "File changed on disk. Reload or save a copy before formatting.", 409);
  }
  private async execute(
    cli: string,
    args: string[],
    cwd: string,
    formatter: Formatter,
    source: string,
    sql: boolean,
    deadline: number,
  ): Promise<string> {
    if (this.closed) throw new WorkspaceError("FORMATTER_CLOSED", "The workspace formatter is closed", 503);
    if (Date.now() >= deadline)
      throw new WorkspaceError("FORMATTER_TIMEOUT", "The repository formatter exceeded its 5 second limit", 408);
    return new Promise((accept, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      let failure: WorkspaceError | undefined,
        outputBytes = 0,
        errorBytes = 0,
        storedDiagnostics = 0;
      const output: Buffer[] = [],
        diagnostics: Buffer[] = [];
      const timer = setTimeout(
        () => {
          failure = new WorkspaceError(
            "FORMATTER_TIMEOUT",
            "The repository formatter exceeded its 5 second limit. Check its configuration and plugins.",
            408,
          );
          terminate(child);
        },
        Math.max(1, deadline - Date.now()),
      );
      child.stdout.on("data", (data: Buffer) => {
        outputBytes += data.length;
        if (outputBytes > maxBytes) {
          failure = new WorkspaceError("FORMATTER_OUTPUT", "Formatted output exceeds the 512 KiB editor limit", 413);
          terminate(child);
        } else output.push(data);
      });
      child.stderr.on("data", (data: Buffer) => {
        errorBytes += data.length;
        const available = 16384 - storedDiagnostics;
        if (available > 0) {
          const kept = data.subarray(0, available);
          diagnostics.push(kept);
          storedDiagnostics += kept.length;
        }
        if (errorBytes > 65536) {
          failure = new WorkspaceError(
            "FORMATTER_OUTPUT",
            "Formatter diagnostics exceeded the 64 KiB limit. Inspect the repository formatter configuration.",
            413,
          );
          terminate(child);
        }
      });
      child.stdin.on("error", () => {
        /* An early parser/tool failure is reported by its exit code. */
      });
      child.once("error", () => {
        failure = new WorkspaceError(
          "FORMATTER_START",
          "Could not start the installed repository formatter. Check its installation and permissions.",
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (failure) {
          reject(failure);
          return;
        }
        const details = Buffer.concat(diagnostics).toString("utf8");
        if (formatter === "biome" && /not formatted[\s\S]*?(?:ignored|disabled)/iu.test(details)) {
          reject(
            new WorkspaceError(
              /ignored/iu.test(details) ? "FORMATTER_IGNORED" : "FORMATTER_DISABLED",
              /ignored/iu.test(details)
                ? "Biome ignores this file under the repository configuration"
                : "The repository Biome configuration disables formatting for this file",
            ),
          );
          return;
        }
        if (code !== 0) {
          if (details) process.stderr.write(`[playground ${formatter}] ${details}\n`);
          reject(
            new WorkspaceError(
              "FORMATTER_FAILED",
              sql
                ? `${formatter} did not accept this SQL file. Check SQL parser support, repository configuration and syntax; detailed diagnostics are in the local terminal.`
                : `${formatter} rejected the buffer or repository configuration. Check the local terminal for formatter diagnostics.`,
            ),
          );
          return;
        }
        try {
          accept(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)));
        } catch {
          reject(new WorkspaceError("FORMATTER_ENCODING", "The repository formatter returned invalid UTF-8"));
        }
      });
      child.stdin.end(source);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const children = [...this.children];
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolvePromise) => {
            child.once("close", () => resolvePromise());
            terminate(child);
          }),
      ),
    );
  }
}
