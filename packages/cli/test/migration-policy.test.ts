import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import type { MigrationsConfig } from "../../migrations/src/index.js";
import { loadMigrationPolicy } from "../src/migration-policy.js";

const config: MigrationsConfig = { directory: "migrations", targets: {} };
await describe("static migration policy", async () => {
  await it("qualifies TS7 custom-root metadata and resolves inherited JSONC policy relative to declaring config", async () => {
    const root = await mkdtemp(join(tmpdir(), "migration-policy-"));
    try {
      await mkdir(join(root, "app"));
      await writeFile(
        join(root, "migration-policy.json"),
        '{ // organizational policy\n "drift":"block", "unknownEvidence":"block", "managedNamespaces":["public"], }',
      );
      await writeFile(
        join(root, "base.json"),
        JSON.stringify({ typedSql: { migrations: { policyFile: "./migration-policy.json" } } }),
      );
      await writeFile(join(root, "app", "query.ts"), "export const value = 1;\n");
      await writeFile(
        join(root, "app", "tsconfig.json"),
        JSON.stringify({ extends: "../base.json", files: ["query.ts"], compilerOptions: { noEmit: true, types: [] } }),
      );
      const loaded = await loadMigrationPolicy({ root, config, projects: ["app/tsconfig.json"] });
      strict.equal(loaded.policy?.drift, "block");
      strict.deepEqual(loaded.policy?.managedNamespaces, ["public"]);
      const require = createRequire(import.meta.url);
      const manifestPath = require.resolve("typescript/package.json");
      const manifest = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(manifestPath, "utf8"))) as {
        version: string;
        bin: { tsc: string };
      };
      strict.match(manifest.version, /^7\./u);
      const shown = execFileSync(
        process.execPath,
        [
          resolve(dirname(manifestPath), manifest.bin.tsc),
          "--showConfig",
          "--project",
          join(root, "app", "tsconfig.json"),
        ],
        { encoding: "utf8" },
      );
      strict.ok(JSON.parse(shown).compilerOptions.noEmit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await it("blocks weakening and conflicting policy declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "migration-policy-"));
    try {
      await writeFile(join(root, "policy.json"), '{"drift":"ignore"}');
      await strict.rejects(
        loadMigrationPolicy({ root, config: { ...config, policyFile: "policy.json" } }),
        /weakening/,
      );
      await writeFile(join(root, "policy.json"), '{"drift":"block"}');
      await strict.rejects(
        loadMigrationPolicy({ root, config: { ...config, policyFile: "policy.json", policy: { drift: "block" } } }),
        /conflicting/,
      );
      await writeFile(join(root, "a.json"), '{"extends":"./b.json"}');
      await writeFile(join(root, "b.json"), '{"extends":"./a.json"}');
      await strict.rejects(loadMigrationPolicy({ root, config, projects: ["a.json"] }), /Cyclic/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
