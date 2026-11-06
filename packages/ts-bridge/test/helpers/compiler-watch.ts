import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { typescriptPreviewCliPath } from "../../src/native-lsp.js";

export function completedWatchCycle(output: string): { readonly text: string; readonly errors: number } | undefined {
  const starts = [
    ...output.matchAll(/(?:Starting compilation in watch mode|Starting incremental compilation)\.\.\./gu),
  ];
  const start = starts.at(-1)?.index;
  if (start === undefined) return undefined;
  const text = output.slice(start);
  const summary = /Found (\d+) errors?\. Watching for file changes\./u.exec(text);
  return summary === null ? undefined : { text, errors: Number(summary[1]) };
}

/** The official native CLI, without its Node wrapper, so closing the test closes the watcher. */
export async function compilerWatch(directory: string, externalCode = false) {
  const { default: getExePath } = await import(
    pathToFileURL(resolve(dirname(typescriptPreviewCliPath()), "../lib/getExePath.js")).href
  );
  const child = spawn(
    getExePath(),
    [
      "-p",
      directory,
      ...(externalCode ? ["--runExternalCode"] : []),
      "--watch",
      "--preserveWatchOutput",
      "--pretty",
      "false",
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let transcript = "";
  let stage = "initial compilation";
  let failure: Error | undefined;
  let closed = false;
  const started = Date.now();
  const capture = (channel: string, data: Buffer) => {
    output += String(data);
    transcript = `${transcript}[${Date.now() - started}ms ${stage} ${channel}] ${String(data)}`.slice(-64_000);
  };
  child.stdout.on("data", (data: Buffer) => capture("stdout", data));
  child.stderr.on("data", (data: Buffer) => capture("stderr", data));
  child.on("error", (error) => {
    failure = error;
  });
  const close = new Promise<void>((done) =>
    child.once("close", () => {
      closed = true;
      done();
    }),
  );

  const waitForCycle = async (errors: number, diagnostic?: RegExp) => {
    const deadline = Date.now() + 20_000;
    while (true) {
      const cycle = completedWatchCycle(output);
      if (cycle?.errors === errors && (diagnostic === undefined || diagnostic.test(cycle.text))) return;
      if (failure !== undefined || closed || Date.now() >= deadline) {
        throw new Error(
          `Compiler watch failed during ${stage}; expected ${errors} errors${diagnostic === undefined ? "" : ` and ${diagnostic}`}; exit=${child.exitCode}, signal=${child.signalCode}.\n${transcript}`,
          { cause: failure },
        );
      }
      await new Promise((done) => setTimeout(done, 10));
    }
  };

  return {
    ready: () => waitForCycle(0),
    async change(label: string, edit: () => Promise<unknown>, errors: number, diagnostic?: RegExp) {
      stage = label;
      // A previous cycle's trailing summary cannot acknowledge the next edit.
      output = "";
      transcript = `${transcript}[${Date.now() - started}ms edit ${stage}]\n`.slice(-64_000);
      await edit();
      await waitForCycle(errors, diagnostic);
    },
    async close() {
      if (closed) return;
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        child.kill();
        await close;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
