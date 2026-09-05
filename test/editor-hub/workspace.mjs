import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceFor } from "./cases.mjs";

export async function prepareWorkspace(workspace, root, spec) {
  await mkdir(join(workspace, "node_modules/@typed-sql"), { recursive: true });
  for (const [name, directory] of [
    ["@typed-sql/core", "packages/core"],
    [spec.packageName, spec.packageDirectory],
  ])
    await symlink(join(root, directory), join(workspace, "node_modules", name), "junction");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module", private: true }));
  await writeFile(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2024", module: "NodeNext", skipLibCheck: true },
      include: ["query.ts", "database.ts"],
    }),
  );
  await copyFile(join(root, "test/fixtures/success/database.ts"), join(workspace, "database.ts"));
  await writeFile(join(workspace, "schema.json"), JSON.stringify(spec.schema));
  await writeFile(
    join(workspace, "typed-sql.config.ts"),
    `import { ${spec.factory} } from ${JSON.stringify(spec.packageName)};\nexport default { dialect: ${spec.factory}(), schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"] };\n`,
  );
  await writeFile(join(workspace, "query.ts"), sourceFor(spec));
  return {
    configPath: join(workspace, "typed-sql.config.ts"),
    schemaPath: join(workspace, "schema.json"),
    projectFile: join(workspace, "tsconfig.json"),
  };
}
