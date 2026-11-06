import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { type CatalogEvidence, loadInventory, validateHistory } from "../src/index.js";

const execFile = promisify(callback);

await describe("migration artifact determinism", async () => {
  await it("hashes Unicode object keys identically under different process locales", async () => {
    const source = `import {canonical,digest} from ${JSON.stringify(new URL("../src/codec.ts", import.meta.url).href)};
console.log(JSON.stringify({locale:Intl.DateTimeFormat().resolvedOptions().locale,canonical:canonical({'ä':2,z:1}),hash:digest({'ä':2,z:1})}));`;
    const loader = createRequire(import.meta.url).resolve("tsx/esm");
    const run = async (locale: string) =>
      JSON.parse(
        (
          await execFile(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
            env: { ...process.env, LC_ALL: locale, LANG: locale },
          })
        ).stdout,
      ) as { locale: string; canonical: string; hash: string };
    const english = await run("en_US.UTF-8");
    const swedish = await run("sv_SE.UTF-8");
    strict.notEqual(
      english.locale,
      swedish.locale,
      "The regression must exercise genuinely different default collations",
    );
    strict.equal(english.canonical, '{"z":1,"ä":2}');
    strict.equal(english.canonical, swedish.canonical);
    strict.equal(english.hash, swedish.hash);
  });

  await it("orders valid mixed-case IDs consistently with prefix and history comparison", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "typed-sql-migration-order-")));
    try {
      const ids = ["a_b", "a", "B", "a-b", "A"];
      for (const [index, id] of ids.entries()) {
        // Separate directory names also exercise ordering on case-insensitive filesystems.
        const path = join(root, "migrations", `entry-${index}`);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "migration.json"), JSON.stringify({ formatVersion: 1, id, up: "up.sql" }));
        await writeFile(join(path, "up.sql"), "select 1");
      }
      const inventory = await loadInventory(root, "migrations", {
        placeholder: (index) => `$${index}`,
        quoteIdentifier: (value) => `"${value}"`,
      });
      strict.deepEqual(
        inventory.migrations.map((migration) => migration.id),
        [...ids].sort(),
      );
      const catalog: CatalogEvidence = {
        formatVersion: 1,
        dialect: "test",
        serverMajor: "1",
        namespaces: ["public"],
        coverage: "complete",
        objects: {},
      };
      strict.doesNotThrow(() =>
        validateHistory(
          {
            formatVersion: 1,
            applied: inventory.migrations.map((migration, index) => ({
              id: migration.id,
              hash: migration.hash,
              catalog,
              direction: "up",
              attemptId: String(index),
              origin: "executed",
            })),
            attempts: inventory.migrations.map((migration, index) => ({
              id: String(index),
              migrationId: migration.id,
              hash: migration.hash,
              direction: "up",
              state: "applied",
            })),
          },
          inventory.migrations,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
