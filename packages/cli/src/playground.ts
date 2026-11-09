import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfigSource } from "@typed-sql/config";

/** Resolve the optional host from the application, never from the CLI dependency graph. */
export async function runPlayground(options: Readonly<Record<string, string>>): Promise<void> {
  const accepted = new Set(["config", "project", "target", "port", "no-open"]);
  for (const key of Object.keys(options)) if (!accepted.has(key)) throw new Error(`Unknown playground option --${key}`);
  const loaded = await loadConfigSource({ ...(options.config === undefined ? {} : { file: options.config }) });
  const require = createRequire(join(loaded.directory, "package.json"));
  let entry: string;
  try {
    entry = require.resolve("@typed-sql/playground");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")
      throw new Error("Install the optional local workspace: pnpm add -D @typed-sql/playground");
    throw error;
  }
  const host: unknown = await import(pathToFileURL(entry).href);
  if (!host || typeof host !== "object" || !("startPlayground" in host) || typeof host.startPlayground !== "function")
    throw new Error(
      "Installed @typed-sql/playground has an incompatible host API. Use the matching typed-sql package set.",
    );
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new Error("--port must be an integer between 0 and 65535");
  const server = (await host.startPlayground({
    config: loaded.file,
    ...(options.project ? { project: options.project } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(port === undefined ? {} : { port }),
  })) as { url: string; close(): Promise<void> };
  process.stdout.write(
    `typed-sql workspace\n${server.url}\n${options.target ? `Target: ${options.target}` : "Offline schema and source analysis"}\nPress Ctrl+C to stop.\n`,
  );
  if (options["no-open"] === undefined) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const browser = spawn(command, [server.url], { stdio: "ignore" });
    browser.on("error", () => process.stderr.write("Open the printed local URL in your browser.\n"));
    browser.unref();
  }
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.close().then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    };
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
