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
    capabilityFiles: [
      "batches",
      "bulk",
      "cancellation",
      "cardinality",
      "mutations",
      "observation",
      "pipelines",
      "prepared",
      "queries",
      "routing",
      "streams",
      "transactions",
      "validation",
    ],
  },
  {
    directory: "mysql",
    dialect: "mysql",
    driver: ["mysql2", "3.24.1"],
    documentation: "mysql",
    databaseFiles: ["Containerfile", ".containerignore", ".dockerignore", "compose.yaml"],
    capabilityFiles: [
      "batches",
      "bulk",
      "cancellation",
      "cardinality",
      "mutations",
      "observation",
      "prepared",
      "queries",
      "routing",
      "streams",
      "transactions",
      "validation",
    ],
  },
  {
    directory: "sqlite",
    dialect: "sqlite",
    driver: undefined,
    documentation: "sqlite",
    databaseFiles: ["src/setup.ts"],
    capabilityFiles: [
      "batches",
      "capabilities",
      "cardinality",
      "mutations",
      "prepared",
      "queries",
      "streams",
      "transactions",
      "validation",
    ],
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
        "src/run.ts",
        "test/example.test.ts",
        "database-test/capabilities.test.ts",
        ...example.capabilityFiles.map((file) => `src/${file}.ts`),
        ...example.databaseFiles,
      ]) {
        strict.ok(await exists(`${directory}/${path}`), `${directory}/${path} is missing`);
      }

      const packageJson = JSON.parse(await text(`${directory}/package.json`)) as {
        readonly scripts: Readonly<Record<string, string>>;
      };
      for (const script of ["generate", "generate:snapshot", "check", "start", "test", "test:database"]) {
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

  await it("renders every maintained capability and its real test in the website", async () => {
    for (const example of examples) {
      const documentation = await text(`docs/examples/${example.documentation}.md`);
      for (const source of [
        "schema/001-schema.sql",
        "typed-sql.config.ts",
        "src/run.ts",
        "database-test/capabilities.test.ts",
        ...example.capabilityFiles.map((file) => `src/${file}.ts`),
      ]) {
        strict.ok(
          documentation.includes(`<<< ../../examples/${example.directory}/${source}`),
          `${example.documentation} does not render ${source}`,
        );
      }
    }
  });

  await it("keeps the complete lifecycle protected by the repository and CI entrypoints", async () => {
    const rootPackage = JSON.parse(await text("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    strict.strictEqual(rootPackage.scripts["e2e:examples"], "pnpm build && node examples/e2e.mjs");
    strict.ok(await exists("examples/check.mjs"));
    strict.ok(await exists("examples/e2e.mjs"));

    const workflow = await text(".github/workflows/ci.yml");
    strict.match(workflow, /examples-e2e:/u);
    for (const example of examples) strict.match(workflow, new RegExp(`example: ${example.directory}`, "u"));
  });

  await it("keeps the mixed PostgreSQL and SQLite application independently generated and executable", async () => {
    const directory = "examples/multi-database";
    for (const path of [
      "README.md",
      "package.json",
      "tsconfig.json",
      "Containerfile",
      "compose.yaml",
      "postgres/typed-sql.config.ts",
      "postgres/schema/001-schema.sql",
      "postgres/schema/catalog.snapshot.json",
      "postgres/generated/db/index.ts",
      "postgres/generated/db/schema.json",
      "postgres/src/queries.ts",
      "postgres/.zed/settings.json",
      "sqlite/typed-sql.config.ts",
      "sqlite/schema/001-schema.sql",
      "sqlite/schema/catalog.snapshot.json",
      "sqlite/generated/db/index.ts",
      "sqlite/generated/db/schema.json",
      "sqlite/src/queries.ts",
      "sqlite/.zed/settings.json",
      "src/service.ts",
      "src/run.ts",
      "src/main.ts",
      "test/example.test.ts",
      "database-test/multi-database.test.ts",
    ]) {
      strict.ok(await exists(`${directory}/${path}`), `${directory}/${path} is missing`);
    }

    const packageJson = JSON.parse(await text(`${directory}/package.json`)) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    for (const dependency of ["@typed-sql/core", "@typed-sql/postgres", "@typed-sql/sqlite"]) {
      strict.strictEqual(packageJson.dependencies[dependency], "workspace:*");
    }
    strict.strictEqual(packageJson.dependencies.pg, "8.23.0");
    for (const script of ["generate", "generate:snapshot", "check", "start", "test", "test:database"]) {
      strict.ok(packageJson.scripts[script], `${directory} is missing its ${script} script`);
    }

    const documentation = await text("docs/examples/multi-database.md");
    for (const source of [
      "postgres/typed-sql.config.ts",
      "postgres/src/queries.ts",
      "sqlite/typed-sql.config.ts",
      "sqlite/src/queries.ts",
      "src/service.ts",
      "src/run.ts",
      "database-test/multi-database.test.ts",
    ]) {
      strict.ok(documentation.includes(`<<< ../../examples/multi-database/${source}`));
    }

    const workflow = await text(".github/workflows/ci.yml");
    strict.match(workflow, /example: multi-database/u);
  });
});
