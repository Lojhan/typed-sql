import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const examples = [
  {
    directory: "postgres",
    dialect: "postgres",
    driver: ["pg", "8.23.0"],
    documentation: "postgresql",
    databaseFiles: ["Containerfile", ".containerignore", ".dockerignore", "compose.yaml"],
  },
  {
    directory: "mysql",
    dialect: "mysql",
    driver: ["mysql2", "3.24.1"],
    documentation: "mysql",
    databaseFiles: ["Containerfile", ".containerignore", ".dockerignore", "compose.yaml"],
  },
  {
    directory: "sqlite",
    dialect: "sqlite",
    driver: undefined,
    documentation: "sqlite",
    databaseFiles: ["src/setup.ts"],
  },
] as const;

async function text(path: string): Promise<string> {
  return readFile(join(workspace, path), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(join(workspace, path))).isFile();
  } catch {
    return false;
  }
}

await describe("maintained application examples", async () => {
  await it("tracks the checked-out packages while applications own their drivers", async () => {
    for (const example of examples) {
      const packageJson = JSON.parse(await text(`examples/${example.directory}/package.json`)) as {
        readonly private: boolean;
        readonly dependencies: Readonly<Record<string, string>>;
        readonly devDependencies: Readonly<Record<string, string>>;
      };

      strict.strictEqual(packageJson.private, true);
      strict.strictEqual(packageJson.dependencies["@typed-sql/core"], "workspace:*");
      strict.strictEqual(packageJson.dependencies[`@typed-sql/${example.dialect}`], "workspace:*");
      strict.strictEqual(packageJson.devDependencies["@typed-sql/cli"], "workspace:*");
      strict.strictEqual(packageJson.devDependencies["@typed-sql/language-server"], "workspace:*");

      if (example.driver !== undefined) {
        strict.strictEqual(packageJson.dependencies[example.driver[0]], example.driver[1]);
      }
    }
  });

  await it("keeps every example runnable, generated, tested, and editor-ready", async () => {
    for (const example of examples) {
      const directory = `examples/${example.directory}`;
      for (const path of [
        "README.md",
        "package.json",
        "tsconfig.json",
        "typed-sql.config.ts",
        ".zed/settings.json",
        "schema/001-schema.sql",
        "schema/catalog.snapshot.json",
        "generated/db/index.ts",
        "generated/db/schema.json",
        "src/main.ts",
        "src/queries.ts",
        "src/run.ts",
        "test/example.test.ts",
        ...example.databaseFiles,
      ]) {
        strict.ok(await exists(`${directory}/${path}`), `${directory}/${path} is missing`);
      }

      const packageJson = JSON.parse(await text(`${directory}/package.json`)) as {
        readonly scripts: Readonly<Record<string, string>>;
      };
      for (const script of ["generate", "generate:snapshot", "check", "start", "test"]) {
        strict.ok(packageJson.scripts[script], `${directory} is missing its ${script} script`);
      }

      const generated = JSON.parse(await text(`${directory}/generated/db/schema.json`)) as {
        readonly dialect: string;
        readonly metadata?: { readonly schemaHash?: string };
      };
      strict.strictEqual(generated.dialect, example.dialect);
      strict.match(generated.metadata?.schemaHash ?? "", /^[a-f0-9]{64}$/u);
    }
  });

  await it("renders the maintained config, query, and execution sources in the website", async () => {
    for (const example of examples) {
      const documentation = await text(`docs/examples/${example.documentation}.md`);
      for (const source of ["schema/001-schema.sql", "typed-sql.config.ts", "src/queries.ts", "src/run.ts"]) {
        strict.ok(
          documentation.includes(`<<< ../../examples/${example.directory}/${source}`),
          `${example.documentation} does not render ${source}`,
        );
      }
    }
  });
});
