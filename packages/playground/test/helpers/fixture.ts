import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const snapshot = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    "public.accounts": {
      name: "accounts",
      schema: "public",
      columns: {
        id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
        name: { name: "name", databaseType: "text", tsType: "string", nullable: true },
      },
    },
  },
};
export async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-workspace-test-"));
  try {
    await mkdir(join(directory, "node_modules/@typed-sql"), { recursive: true });
    for (const name of ["core", "postgres", "playground"])
      await symlink(join(workspace, "packages", name), join(directory, "node_modules/@typed-sql", name), "dir");
    for (const name of ["typescript", "@types"])
      await symlink(join(workspace, "node_modules", name), join(directory, "node_modules", name), "dir");
    await mkdir(join(directory, "playground"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "playground-consumer", type: "module", private: true }),
    );
    await writeFile(join(directory, "schema.json"), JSON.stringify(snapshot));
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2024",
          types: ["node"],
          allowArbitraryExtensions: true,
        },
        include: ["playground/**/*.ts"],
      }),
    );
    await writeFile(
      join(directory, "typed-sql.config.mjs"),
      `import {postgres} from '@typed-sql/postgres';\nimport {createPostgresDatabase} from '@typed-sql/postgres/runtime';\nimport {renderer} from '@typed-sql/postgres/query';\nexport default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],playground:{readRoots:['playground'],writeRoots:['playground'],targets:{local:{classification:'development',expected:{database:'test'},connect:()=>({identity:async()=>({database:'test',server:'test',adapter:'fixture',readOnly:true}),query:async request=>({columns:[{name:'id'}],rows:[[request.values[0]??42]],truncated:false}),database:async()=>createPostgresDatabase({pool:{query:async()=>({rows:[{id:42,name:null}]}),end:async()=>{}}}),close:async()=>{}})}}}};\n`,
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
