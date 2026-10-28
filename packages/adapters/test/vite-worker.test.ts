import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "poku";
import { assertPortableWorkerConsumer } from "../../../test/helpers/portable-worker-consumer.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
await it("builds SQL files and inline templates into a compiler-free Worker and executes real D1", async () => {
  const directory = await mkdtemp(join(workspace, ".portable-worker-"));
  try {
    const scope = join(directory, "node_modules/@typed-sql");
    await mkdir(scope, { recursive: true });
    for (const name of ["core", "sqlite", "adapters", "ts-bridge"])
      await symlink(
        join(workspace, "packages", name),
        join(scope, name),
        process.platform === "win32" ? "junction" : "dir",
      );
    const require = createRequire(join(workspace, "packages/ts-bridge/package.json"));
    await assertPortableWorkerConsumer({
      consumer: directory,
      viteUrl: pathToFileURL(require.resolve("vite")).href,
      miniflareUrl: import.meta.resolve("miniflare"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
