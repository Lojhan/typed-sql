import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { loadReleaseManifest } from "../../scripts/release-policy.mjs";

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
  readonly exports?: string | Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly typedSql?: { readonly releaseTrack?: "stable" | "experimental" };
}

const directory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(directory, "../..");
const forbiddenDrivers = new Set(["pg", "mysql2", "better-sqlite3", "sqlite3"]);
const publicPackages = [
  "ast",
  "core",
  "config",
  "schema",
  "postgres",
  "mysql",
  "compiler",
  "cli",
  "ts-bridge",
  "language-server",
] as const;
const stablePackages = ["core", "ast", "schema", "config", "compiler", "postgres", "mysql", "cli"] as const;
const experimentalPackages = ["ts-bridge", "language-server"] as const;
const expectedEntrypoints: Readonly<Record<(typeof publicPackages)[number], readonly string[]>> = {
  ast: ["."],
  core: ["."],
  config: ["."],
  schema: ["."],
  postgres: [".", "./runtime", "./pg"],
  mysql: [".", "./runtime", "./mysql2"],
  compiler: ["."],
  cli: [],
  "ts-bridge": [".", "./native-lsp", "./native-preview"],
  "language-server": ["."],
};

async function manifest(packageName: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(join(workspace, "packages", packageName, "package.json"), "utf8"),
  ) as PackageManifest;
}

async function source(packageName: string): Promise<string> {
  const directoryPath = join(workspace, "packages", packageName, "src");
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) await visit(item);
      else if (entry.name.endsWith(".ts")) files.push(item);
    }
  };
  await visit(directoryPath);
  files.sort();
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

await describe("public package graph", async () => {
  await it("keeps core, compiler, CLI, and dialect roots free of installed drivers", async () => {
    for (const packageName of ["core", "config", "compiler", "cli", "language-server", "postgres", "mysql"]) {
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
    strict.strictEqual(packageManifest.dependencies?.["@types/pg"], "8.23.1");
  });

  await it("keeps mysql2 entirely application-owned instead of declaring a peer", async () => {
    const packageManifest = await manifest("mysql");
    strict.strictEqual(packageManifest.dependencies?.mysql2, undefined);
    strict.strictEqual(packageManifest.optionalDependencies?.mysql2, undefined);
    strict.strictEqual(packageManifest.peerDependencies?.mysql2, undefined);
  });

  await it("keeps pg types behind the explicit driver adapter subpath", async () => {
    const providerDeclaration = await readFile(
      join(workspace, "packages", "postgres", "dist", "packages", "postgres", "src", "provider.d.ts"),
      "utf8",
    );
    strict.ok(!providerDeclaration.includes('from "pg"'));
    strict.ok(!providerDeclaration.includes('import("pg")'));
  });

  await it("keeps mysql2 types behind the explicit driver adapter subpath", async () => {
    const providerDeclaration = await readFile(
      join(workspace, "packages", "mysql", "dist", "packages", "mysql", "src", "provider.d.ts"),
      "utf8",
    );
    strict.ok(!providerDeclaration.includes('from "mysql2'));
    strict.ok(!providerDeclaration.includes('import("mysql2'));
  });

  await it("keeps the compiler source dialect-neutral", async () => {
    const compiler = await source("compiler");
    strict.ok(!compiler.includes("@typed-sql/postgres"));
    strict.ok(!compiler.includes('=== "postgres"'));
    strict.deepStrictEqual(Object.keys((await manifest("compiler")).dependencies ?? {}), ["@typed-sql/core"]);
  });

  await it("keeps every neutral package free of dialect, driver, and SQL-feature decisions", async () => {
    const neutralPackages = ["core", "compiler", "config", "schema"] as const;
    const forbiddenSource = [
      { label: "first-party dialect name", pattern: /\b(?:postgres(?:ql)?|mysql2?)\b/iu },
      { label: "dialect-specific RETURNING", pattern: /\bRETURNING\b/u },
      { label: "dialect-specific DISTINCT ON", pattern: /\bDISTINCT\s+ON\b/u },
      { label: "dialect-specific FULL JOIN", pattern: /\bFULL\s+JOIN\b/u },
      { label: "dialect-specific JSON_EXTRACT", pattern: /\bJSON_EXTRACT\b/u },
      { label: "dialect-specific TIMESTAMPTZ", pattern: /\bTIMESTAMPTZ\b/u },
    ] as const;
    for (const packageName of neutralPackages) {
      const packageSource = await source(packageName);
      for (const forbidden of forbiddenSource) {
        strict.ok(!forbidden.pattern.test(packageSource), `${packageName} contains ${forbidden.label}`);
      }
      const dependencies = Object.keys((await manifest(packageName)).dependencies ?? {});
      for (const dependency of dependencies) {
        strict.ok(
          dependency !== "@typed-sql/postgres" &&
            dependency !== "@typed-sql/mysql" &&
            !forbiddenDrivers.has(dependency),
          `${packageName} depends on dialect or driver ${dependency}`,
        );
      }
    }
  });

  await it("loads editor grammars through config instead of a PostgreSQL dependency", async () => {
    for (const packageName of ["language-server", "vscode"]) {
      const packageManifest = await manifest(packageName);
      strict.strictEqual(packageManifest.dependencies?.["@typed-sql/postgres"], undefined);
      strict.ok(!(await source(packageName)).includes("@typed-sql/postgres"));
    }
  });

  await it("publishes consistent Lojhan-owned release metadata", async () => {
    const releaseManifest = await loadReleaseManifest(workspace);
    const betaPattern = new RegExp(`^${releaseManifest.series.replaceAll(".", "\\.")}-beta\\.\\d+$`, "u");
    const prereleasePattern = new RegExp(`^${releaseManifest.series.replaceAll(".", "\\.")}-(?:beta|rc)\\.\\d+$`, "u");
    const expectedLicense = await readFile(join(workspace, "LICENSE"), "utf8");
    strict.deepStrictEqual(
      releaseManifest.packagePolicy.stable,
      stablePackages.map((name) => `@typed-sql/${name}`),
    );
    strict.deepStrictEqual(
      releaseManifest.packagePolicy.experimental,
      experimentalPackages.map((name) => `@typed-sql/${name}`),
    );
    const releaseOrder = new Map(releaseManifest.packages.map((name, index) => [name, index]));
    for (const packageName of publicPackages) {
      const packageManifest = await manifest(packageName);
      const releaseTrack = stablePackages.includes(packageName as (typeof stablePackages)[number])
        ? "stable"
        : "experimental";
      if (releaseManifest.channel === "beta") {
        strict.ok(
          betaPattern.test(packageManifest.version ?? ""),
          `${packageManifest.name} must be in the declared beta series`,
        );
      } else if (releaseTrack === "stable") strict.strictEqual(packageManifest.version, releaseManifest.series);
      else strict.ok(prereleasePattern.test(packageManifest.version ?? ""));
      strict.strictEqual(packageManifest.typedSql?.releaseTrack, releaseTrack);
      strict.notStrictEqual(packageManifest.private, true);
      strict.strictEqual(packageManifest.license, "MIT");
      strict.strictEqual(packageManifest.author, "Lojhan");
      strict.ok(packageManifest.repository?.url?.includes("github.com/Lojhan/typed-sql"));
      strict.ok(packageManifest.files?.some((entry) => entry.startsWith("dist/")));
      for (const document of ["README.md", "LICENSE", "CHANGELOG.md"]) {
        strict.ok(packageManifest.files?.includes(document), `${packageManifest.name} must publish ${document}`);
      }
      strict.strictEqual(
        await readFile(join(workspace, "packages", packageName, "LICENSE"), "utf8"),
        expectedLicense,
        `${packageManifest.name} must ship the complete repository license`,
      );
      const packageIndex = releaseOrder.get(packageManifest.name);
      if (packageIndex !== undefined) {
        for (const dependency of Object.keys(packageManifest.dependencies ?? {})) {
          const dependencyIndex = releaseOrder.get(dependency);
          if (dependencyIndex === undefined) continue;
          strict.ok(
            dependencyIndex < packageIndex,
            `${dependency} must precede ${packageManifest.name} in bootstrap order`,
          );
        }
      }
    }
    strict.ok(!(await source("core")).toLowerCase().includes("vitable"));
  });

  await it("freezes public package entrypoints and executable names", async () => {
    for (const packageName of publicPackages) {
      const packageManifest = await manifest(packageName);
      const entrypoints =
        typeof packageManifest.exports === "string" ? ["."] : Object.keys(packageManifest.exports ?? {}).sort();
      strict.deepStrictEqual(
        entrypoints,
        expectedEntrypoints[packageName].slice().sort(),
        `${packageManifest.name} changed its public entrypoints`,
      );
    }
    strict.deepStrictEqual((await manifest("cli")).bin, {
      "typed-sql": "./dist/packages/cli/src/cli.js",
    });
    strict.deepStrictEqual((await manifest("language-server")).bin, {
      "typed-sql-language-server": "./dist/packages/language-server/src/server.js",
    });
  });

  await it("never packs stale JavaScript for deleted source modules", async () => {
    for (const packageName of publicPackages) {
      const sourceDirectory = join(workspace, "packages", packageName, "src");
      const outputDirectory = join(workspace, "packages", packageName, "dist", "packages", packageName, "src");
      const expected = (await readdir(sourceDirectory))
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
        .map((file) => file.replace(/\.ts$/u, ".js"))
        .sort();
      const emitted = (await readdir(outputDirectory)).filter((file) => file.endsWith(".js")).sort();
      strict.deepStrictEqual(emitted, expected, `${packageName} dist must exactly match its source modules`);
    }
  });

  await it("keeps generated modules schema-only and out of the application API", async () => {
    const generated = await readFile(join(workspace, "e2e", "postgres", "generated", "db", "index.ts"), "utf8");
    strict.ok(generated.includes("Schema metadata only"));
    strict.ok(!generated.includes("export { sql }"));
    strict.ok(!generated.includes("export const typePolicy"));
    strict.ok(!generated.includes('from "pg"'));
    for (const [dialect, packageName] of [
      ["postgres", "@typed-sql/postgres"],
      ["mysql", "@typed-sql/mysql"],
    ] as const) {
      const application = await readFile(join(workspace, "e2e", dialect, "src", "query.ts"), "utf8");
      strict.ok(application.includes(`from "${packageName}"`));
      strict.ok(!application.includes("generated/"));
    }
  });

  await it("makes the E2E application own its selected driver", async () => {
    const consumer = JSON.parse(
      await readFile(join(workspace, "e2e", "postgres", "package.json"), "utf8"),
    ) as PackageManifest;
    strict.strictEqual(consumer.dependencies?.pg, "8.23.0");
    strict.strictEqual(consumer.dependencies?.["@typed-sql/postgres"], "workspace:*");
    const mysqlConsumer = JSON.parse(
      await readFile(join(workspace, "e2e", "mysql", "package.json"), "utf8"),
    ) as PackageManifest;
    strict.strictEqual(mysqlConsumer.dependencies?.mysql2, "3.24.1");
    strict.strictEqual(mysqlConsumer.dependencies?.["@typed-sql/mysql"], "workspace:*");
  });
});
