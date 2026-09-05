import { copyFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function prepareOverlayWorkspace(workspace, root) {
  // Real built packages, not a protocol probe. Packed dependency installation is
  // independently exercised by the packed-consumer suite.
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), "junction");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module", private: true }));
  await writeFile(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2024", module: "NodeNext", skipLibCheck: true },
      include: ["query.ts", "database.ts"],
    }),
  );
  for (const file of ["schema.json", "database.ts"])
    await copyFile(join(root, "test/fixtures/success", file), join(workspace, file));
  await writeFile(
    join(workspace, "typed-sql.config.ts"),
    'import { postgres } from "@typed-sql/postgres";\nexport default { dialect: postgres(), schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"] };\n',
  );
  await writeFile(
    join(workspace, ".vscode/settings.json"),
    JSON.stringify({
      "typedSql.serverPath": join(root, "packages/language-server/dist/packages/language-server/src/server.js"),
      "typedSql.configPath": join(workspace, "typed-sql.config.ts"),
      "typedSql.schemaPath": join(workspace, "schema.json"),
      "typedSql.projectFile": join(workspace, "tsconfig.json"),
    }),
  );
  await writeFile(
    join(workspace, "query.ts"),
    [
      'import { sql } from "@typed-sql/postgres";',
      'import { db } from "./database.js";',
      "const query = sql`SELECT id, name FROM users`; const ordinary = { count: 1 }; void ordinary.count;",
      "async function verify() {",
      "  const rows = await db.execute(query);",
      "  const row = rows[0]!;",
      "  const correct: string = row.name;",
      "  const wrong: number = row.name;",
      "  return row.name;",
      "}",
      "void verify;",
      "",
    ].join("\n"),
  );
}
