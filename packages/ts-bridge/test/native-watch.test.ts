import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { compilerWatch, completedWatchCycle } from "./helpers/compiler-watch.js";

await describe("official TypeScript watch control", async () => {
  await it("requires diagnostics and completion from the same compilation cycle", () => {
    const initial = "Starting compilation in watch mode...\nFound 0 errors. Watching for file changes.\n";
    strict.strictEqual(completedWatchCycle("Found 0 errors. Watching for file changes."), undefined);
    strict.strictEqual(
      completedWatchCycle(`${initial}File change detected. Starting incremental compilation...\nerror TS2322`),
      undefined,
    );
    strict.deepStrictEqual(
      completedWatchCycle(
        "Starting incremental compilation...\nerror TS2322\nFound 1 error. Watching for file changes.",
      ),
      {
        text: "Starting incremental compilation...\nerror TS2322\nFound 1 error. Watching for file changes.",
        errors: 1,
      },
    );
    const restored = completedWatchCycle(
      "Starting compilation in watch mode...\nerror TS2322\nFound 1 error. Watching for file changes.\nStarting incremental compilation...\nFound 0 errors. Watching for file changes.",
    );
    strict.strictEqual(restored?.errors, 0);
    strict.doesNotMatch(restored!.text, /TS2322/u);
  });

  await it("refreshes ordinary TypeScript without a mapper or database driver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-native-watch-"));
    try {
      const file = join(directory, "main.ts");
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
          files: ["main.ts"],
        }),
      );
      let imports = "";
      for (let index = 0; index < 25; index++) {
        await mkdir(join(directory, `lib${index}`));
        await writeFile(join(directory, `lib${index}/index.ts`), "export const value = 1;");
        imports += `import { value as n${index} } from './lib${index}/index.js';\n`;
      }
      await writeFile(file, "const value: number = 1;");
      const watch = await compilerWatch(directory);
      try {
        await watch.ready();
        for (let round = 0; round < 5; round++) {
          await watch.change(
            `ordinary TypeScript error (${round})`,
            () => writeFile(file, 'const value: number = "bad";'),
            1,
            /TS2322/u,
          );
          await watch.change(
            `ordinary TypeScript atomic save (${round})`,
            async () => {
              const replacement = join(directory, "main.ts.tmp");
              await writeFile(replacement, "const value: number = 1;");
              await rename(replacement, file);
            },
            0,
          );
        }
        // Import removal exercises native directory-watch reconciliation too.
        for (let round = 0; round < 3; round++) {
          await watch.change(
            `add import graph (${round})`,
            () => writeFile(file, `${imports}const value: number = n0;`),
            0,
          );
          await watch.change(
            `remove import graph (${round})`,
            () => writeFile(file, 'const value: number = "bad";'),
            1,
            /TS2322/u,
          );
        }
        await watch.change("restore import graph", () => writeFile(file, `${imports}const value: number = n0;`), 0);
      } finally {
        await watch.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
