import { spawn } from "node:child_process";

/** Operates the compiled public CLI; pass boundaries include the child's complete diagnostics. */
export function startWatchedCli(
  entrypoint: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  },
) {
  const child = spawn(process.execPath, [entrypoint, "check", "--watch", ...args], options);
  let output = "",
    consumed = 0,
    exited = false;
  const changed = new Set<() => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const append = (data: string) => {
    output += data;
    for (const notify of changed) notify();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      exited = true;
      resolve(code);
      for (const notify of changed) notify();
    });
  });
  return {
    async pass(edit?: () => Promise<void>): Promise<string> {
      if (edit) await edit();
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
          changed.delete(notify);
          reject(new Error(`Watch check did not finish:\n${output}`));
        }, 30_000);
        const notify = () => {
          const match = /Watch: check finished \([^)]*\); waiting for changes\./u.exec(output.slice(consumed));
          if (!match && !exited) return;
          clearTimeout(deadline);
          changed.delete(notify);
          if (!match) {
            reject(new Error(`Watch exited before its check finished:\n${output}`));
            return;
          }
          const end = consumed + match.index + match[0].length,
            current = output.slice(consumed, end);
          consumed = end;
          resolve(current);
        };
        changed.add(notify);
        notify();
      });
    },
    async close(): Promise<number | null> {
      child.kill("SIGTERM");
      return closed;
    },
  };
}
