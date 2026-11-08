import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type AnalysisRegistration, defineAnalysisRegistration } from "@typed-sql/analysis";
import { listProjectSourceFiles } from "@typed-sql/compiler";
import { fromConfig, type LoadedConfigSource, loadConfigSource } from "@typed-sql/config";

const contains = (directory: string, file: string): boolean => {
  const path = relative(directory, file);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Each pass uses the ordinary CLI in a fresh process; watching never constructs database services. */
export async function watchChecks(input: {
  readonly loaded: LoadedConfigSource;
  readonly options: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  readonly entrypoint: string;
}): Promise<void> {
  let stopped = false,
    running = false,
    dirty = true;
  let child: ChildProcess | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const watchers = new Map<string, FSWatcher>();
  let exact = new Set<string>([input.loaded.file]),
    cache = resolve(input.loaded.directory, ".typed-sql/cache"),
    contracts = resolve(input.loaded.directory, input.loaded.config.outDir, "contracts");
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const report = (message: string) => process.stderr.write(`Watch: ${message}\n`);
  const schedule = () => {
    dirty = true;
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, 250);
  };
  const changed = (root: string, file: string | null, renamed: boolean) => {
    if (file === null) {
      schedule();
      return;
    }
    const path = resolve(root, file);
    if (contains(cache, path)) return;
    if (renamed && contains(path, cache)) {
      // Creating the cache's parent is not a semantic change. Observe siblings without a cache loop.
      void observeTree(path, cache, new Set(), true).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") report(error.message);
      });
      return;
    }
    if (
      relative(root, path)
        .split(sep)
        .some((part) => part === "node_modules" || part === ".git")
    )
      return;
    if (
      renamed ||
      exact.has(path) ||
      /\.(?:[cm]?[jt]sx?|sql|json)$/iu.test(path) ||
      /(?:^|[/\\])tsconfig[^/\\]*\.json$/iu.test(path) ||
      (contains(contracts, path) && path.endsWith(".json"))
    )
      schedule();
  };
  const observe = (root: string) => {
    if (stopped || watchers.has(root)) return;
    const watcher = watch(root, (event, file) => changed(root, file, event === "rename"));
    watcher.on("error", (error) => {
      report(error.message);
      stop("SIGTERM");
    });
    watchers.set(root, watcher);
  };
  const observeTree = async (root: string, ignored: string, selected: Set<string>, discover = false) => {
    controller.signal.throwIfAborted();
    if (contains(ignored, root)) return;
    observe(root);
    selected.add(root);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
        await observeTree(resolve(root, entry.name), ignored, selected, discover);
      else if (discover && entry.isFile() && /\.(?:[cm]?[jt]sx?|sql|json)$/iu.test(entry.name)) schedule();
    }
  };
  const refresh = async () => {
    const loaded = await loadConfigSource({ file: input.loaded.file });
    const projects =
      input.options.project === undefined
        ? (loaded.config.projects ?? ["tsconfig.json"]).map((path) => fromConfig(loaded.directory, path))
        : [resolve(input.options.project)];
    const files = (
      await Promise.all(
        projects.map((project) =>
          listProjectSourceFiles({
            project,
            signal: controller.signal,
            cwd: loaded.directory,
            includeSqlAssets: true,
            ...(input.options.file === undefined ? {} : { entryFile: resolve(input.options.file) }),
          }),
        ),
      )
    ).flat();
    const dependencies = [
      loaded.file,
      ...(loaded.dependencies ?? []),
      ...projects,
      ...files,
      fromConfig(loaded.directory, input.options.schema ?? loaded.config.schema.file),
    ].map((path) => resolve(path));
    const registration =
      loaded.config.analysis === undefined
        ? undefined
        : defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration);
    const nextCache = fromConfig(loaded.directory, registration?.cache?.directory ?? ".typed-sql/cache");
    const nextContracts = fromConfig(
      loaded.directory,
      registration?.contractsDir ?? `${loaded.config.outDir}/contracts`,
    );
    let contractRoot = nextContracts;
    while (true) {
      try {
        if ((await stat(contractRoot)).isDirectory()) break;
        contractRoot = dirname(contractRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(contractRoot);
        if (parent === contractRoot) throw error;
        contractRoot = parent;
      }
    }
    const roots = [...new Set([loaded.directory, contractRoot, ...dependencies.map(dirname)])].sort(
      (a, b) => a.length - b.length,
    );
    const selected = roots.filter((root, index) => !roots.slice(0, index).some((parent) => contains(parent, root)));
    // Add replacements before dropping old watches so scope refresh does not open an observation gap.
    const selectedDirectories = new Set<string>();
    for (const root of selected) await observeTree(root, nextCache, selectedDirectories);
    exact = new Set(dependencies);
    cache = nextCache;
    contracts = nextContracts;
    for (const [root, watcher] of watchers)
      if (!selectedDirectories.has(root)) {
        watcher.close();
        watchers.delete(root);
      }
  };
  const kill = (signal: NodeJS.Signals) => {
    if (!child) return;
    try {
      if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = (signal: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (timer) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    if (child) {
      kill(signal);
      shutdownTimer = setTimeout(() => kill("SIGKILL"), 1_000);
    } else if (!running) finish();
  };
  const interrupt = () => stop("SIGINT"),
    terminate = () => stop("SIGTERM");
  const run = async () => {
    if (stopped || running) return;
    dirty = false;
    running = true;
    try {
      // Keep the last working observation scope if configuration or projects are temporarily invalid.
      await refresh().catch((error: unknown) => {
        if (!stopped) report(error instanceof Error ? error.message : String(error));
      });
      if (stopped) return;
      process.stdout.write("Watch: checking current inputs.\n");
      const result = await new Promise<number | null>((resolve, reject) => {
        child = spawn(process.execPath, [...process.execArgv, input.entrypoint, ...input.args], {
          stdio: "inherit",
          detached: process.platform !== "win32",
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (!stopped)
        process.stdout.write(
          `Watch: check finished (${result ?? "signal"}); ${dirty ? "changes queued" : "waiting for changes"}.\n`,
        );
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      child = undefined;
      running = false;
      if (stopped) finish();
      else if (dirty) schedule();
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await observeTree(input.loaded.directory, cache, new Set());
    await run();
    await done;
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
