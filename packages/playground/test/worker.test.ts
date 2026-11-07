import { fork } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { fixture } from "./helpers/fixture.js";

await describe("worker input verification boundary", async () => {
  await it("rejects changed inputs before evaluating executable project config", async () =>
    fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      const marker = join(directory, "config-executed");
      await writeFile(
        config,
        `import {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(marker)},'executed');\n${await readFile(config, "utf8")}`,
      );
      const child = fork(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), [], {
        cwd: directory,
        execArgv: ["--import", createRequire(import.meta.url).resolve("tsx/esm")],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const events: unknown[] = [];
      child.on("message", (event) => events.push(event));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        child.send({
          config,
          target: "local",
          entry: join(directory, "missing.mjs"),
          mode: "file",
          readOnly: true,
          limits: { maxRows: 5, maxResultBytes: 100000, maxConsoleBytes: 100000, timeoutMs: 2000 },
          files: [{ path: config, hash: "stale-input-hash" }],
        });
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () => resolve());
        });
        strict.match(JSON.stringify(events), /changed before config loading/);
        await strict.rejects(access(marker), { code: "ENOENT" });
      } finally {
        clearTimeout(timeout);
        if (child.connected) child.kill("SIGKILL");
      }
    }));
});
