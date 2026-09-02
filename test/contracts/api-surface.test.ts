import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import { loadReleaseManifest } from "../../scripts/release-policy.mjs";

type Classification = "stable" | "experimental" | "adapter-specific" | "testing" | "internal";
interface SurfaceManifest {
  readonly formatVersion: number;
  readonly classifications: readonly Classification[];
  readonly packages: Readonly<Record<string, Readonly<Record<string, Classification>>>>;
  readonly editors: Readonly<Record<string, Classification>>;
}
interface PackageManifest {
  readonly name: string;
  readonly exports?: string | Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly typedSql?: { readonly releaseTrack?: "stable" | "experimental" };
}

const workspace = resolve(import.meta.dirname, "../..");
const surface = JSON.parse(await readFile(join(workspace, "api-surface.json"), "utf8")) as SurfaceManifest;
const allowed = new Set<Classification>(["stable", "experimental", "adapter-specific", "testing", "internal"]);

await describe("reviewed API surface classifications", async () => {
  await it("classifies every published package entrypoint and executable exactly once", async () => {
    strict.strictEqual(surface.formatVersion, 1);
    strict.deepStrictEqual(new Set(surface.classifications), allowed);
    const directories = (await readdir(join(workspace, "packages"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "vscode")
      .map((entry) => entry.name)
      .sort();
    const actualPackages: string[] = [];
    for (const directory of directories) {
      const manifest = JSON.parse(
        await readFile(join(workspace, "packages", directory, "package.json"), "utf8"),
      ) as PackageManifest;
      actualPackages.push(manifest.name);
      const classified = surface.packages[manifest.name];
      if (!classified) throw new Error(`${manifest.name} has no reviewed API-surface classification`);
      const entrypoints = typeof manifest.exports === "string" ? ["."] : Object.keys(manifest.exports ?? {});
      const executables = Object.keys(manifest.bin ?? {}).map((name) => `bin:${name}`);
      strict.deepStrictEqual(
        Object.keys(classified).sort(),
        [...entrypoints, ...executables].sort(),
        `${manifest.name} entrypoint classification drifted`,
      );
      for (const classification of Object.values(classified)) strict.ok(allowed.has(classification));
      const rootClass = classified["."] ?? classified[executables[0] ?? ""];
      strict.strictEqual(
        rootClass,
        manifest.typedSql?.releaseTrack,
        `${manifest.name} root classification must match its release track`,
      );
      if (manifest.typedSql?.releaseTrack === "stable") {
        strict.ok(
          Object.values(classified).every((value) => value === "stable" || value === "adapter-specific"),
          `${manifest.name} cannot expose an experimental surface from a stable package`,
        );
      }
    }
    strict.deepStrictEqual(Object.keys(surface.packages).sort(), actualPackages.sort());
  });

  await it("matches stable and experimental package ownership in the release manifest", async () => {
    const release = await loadReleaseManifest(workspace);
    for (const name of release.packagePolicy.stable) {
      strict.ok(surface.packages[name], `stable package ${name} is absent from api-surface.json`);
    }
    for (const name of release.packagePolicy.experimental) {
      strict.ok(
        Object.values(surface.packages[name] ?? {}).every((value) => value === "experimental"),
        `experimental package ${name} has a non-experimental entrypoint`,
      );
    }
  });

  await it("classifies both distributed editor integrations as experimental", () => {
    strict.deepStrictEqual(surface.editors, {
      "vscode:typed-sql": "experimental",
      "zed:typed-sql": "experimental",
    });
  });
});
