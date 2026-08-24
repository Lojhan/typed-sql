import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

interface PackageManifest {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly author?: string;
  readonly files?: readonly string[];
  readonly repository?: { readonly url?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

const directory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(directory, "../..");
const forbiddenDrivers = new Set(["pg", "mysql2", "better-sqlite3", "sqlite3"]);

async function manifest(packageName: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(join(workspace, "packages", packageName, "package.json"), "utf8")) as PackageManifest;
}

async function source(packageName: string): Promise<string> {
  const directoryPath = join(workspace, "packages", packageName, "src");
  const files = (await readdir(directoryPath)).filter((file) => file.endsWith(".ts"));
  return (await Promise.all(files.map((file) => readFile(join(directoryPath, file), "utf8")))).join("\n");
}

await describe("public package graph", async () => {
  await it("keeps core, compiler, CLI, and dialect roots free of installed drivers", async () => {
    for (const packageName of ["core", "config", "compiler", "cli", "language-server", "postgres"]) {
      const packageManifest = await manifest(packageName);
      for (const field of [packageManifest.dependencies, packageManifest.optionalDependencies]) {
        for (const dependency of Object.keys(field ?? {})) {
          strict.ok(!forbiddenDrivers.has(dependency), `${packageManifest.name} must not install ${dependency}`);
        }
      }
    }
  });

  await it("keeps pg entirely application-owned instead of declaring a peer", async () => {
    const packageManifest = await manifest("postgres");
    strict.strictEqual(packageManifest.dependencies?.pg, undefined);
    strict.strictEqual(packageManifest.optionalDependencies?.pg, undefined);
    strict.strictEqual(packageManifest.peerDependencies?.pg, undefined);
  });

  await it("keeps pg types behind the explicit driver adapter subpath", async () => {
    const providerDeclaration = await readFile(
      join(workspace, "packages", "postgres", "dist", "packages", "postgres", "src", "provider.d.ts"),
      "utf8",
    );
    strict.ok(!providerDeclaration.includes('from "pg"'));
    strict.ok(!providerDeclaration.includes('import("pg")'));
  });

  await it("keeps the compiler source dialect-neutral", async () => {
    const compiler = await source("compiler");
    strict.ok(!compiler.includes("@typed-sql/postgres"));
    strict.ok(!compiler.includes('=== "postgres"'));
    strict.deepStrictEqual(Object.keys((await manifest("compiler")).dependencies ?? {}), ["@typed-sql/core"]);
  });

  await it("loads editor grammars through config instead of a PostgreSQL dependency", async () => {
    for (const packageName of ["language-server", "vscode"]) {
      const packageManifest = await manifest(packageName);
      strict.strictEqual(packageManifest.dependencies?.["@typed-sql/postgres"], undefined);
      strict.ok(!(await source(packageName)).includes("@typed-sql/postgres"));
    }
  });

  await it("publishes consistent Lojhan-owned 0.2 package metadata", async () => {
    for (const packageName of ["ast", "core", "config", "schema", "postgres", "compiler", "cli", "ts-bridge", "language-server"]) {
      const packageManifest = await manifest(packageName);
      strict.strictEqual(packageManifest.version, "0.2.0");
      strict.notStrictEqual(packageManifest.private, true);
      strict.strictEqual(packageManifest.license, "MIT");
      strict.strictEqual(packageManifest.author, "Lojhan");
      strict.ok(packageManifest.repository?.url?.includes("github.com/Lojhan/typed-sql"));
      strict.ok(packageManifest.files?.every((entry) => entry.startsWith("dist/")));
    }
    strict.ok(!(await source("core")).toLowerCase().includes("vitable"));
  });

  await it("keeps the generated module bound only to core and free of driver imports", async () => {
    const generated = await readFile(join(workspace, "e2e", "postgres", "generated", "db", "index.ts"), "utf8");
    strict.ok(generated.includes('export { sql } from "@typed-sql/core"'));
    strict.ok(!generated.includes('from "pg"'));
  });

  await it("makes the E2E application own its selected driver", async () => {
    const consumer = JSON.parse(await readFile(join(workspace, "e2e", "postgres", "package.json"), "utf8")) as PackageManifest;
    strict.strictEqual(consumer.dependencies?.pg, "8.23.0");
    strict.strictEqual(consumer.dependencies?.["@typed-sql/postgres"], "workspace:*");
  });
});
