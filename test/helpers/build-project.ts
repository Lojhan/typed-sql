import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const buildSnapshot = {
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "1.0.0",
  tables: {
    account: {
      schema: "main",
      name: "account",
      kind: "table",
      strict: true,
      withoutRowid: false,
      indexes: [],
      foreignKeys: [],
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "number", nullable: false },
        email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
      },
    },
  },
};

export const buildInline = `import { sql } from "@typed-sql/sqlite/query";
const emoji = "😀";
export const inline = (id: number) => sql\`SELECT id, email FROM account WHERE id = \${id}\`;
export const repeated = (ids: readonly number[]) => sql\`SELECT id, email FROM account WHERE id IN (\${ids.map(id => sql.fragment\`\${id}\`)}) ORDER BY id\`;
export const conditional = (email: boolean) => sql\`SELECT id\${email ? sql.fragment\`, email\` : sql.empty} FROM account WHERE id = \${1}\`;
void emoji;
`;

export async function prepareBuildProject(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "typed-sql-build-consumer", type: "module", private: true }),
  );
  await writeFile(join(directory, "policy.mjs"), 'export const integer = "number";\n');
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `import { sqlite, typePolicy } from "@typed-sql/sqlite";
import { integer } from "./policy.mjs";
const policy = { ...typePolicy, integer };
export default { dialect: sqlite({ typePolicy: policy }), typePolicy: policy, schema: { file: "schema.json", provider: { async introspect() { throw new Error("Build transforms must not introspect a database"); } } }, outDir: "generated/db", projects: ["tsconfig.json"] };
`,
  );
  await writeFile(join(directory, "schema.json"), JSON.stringify(buildSnapshot));
  await writeFile(join(directory, "query.sql"), "SELECT id, email FROM account WHERE id = ?");
  await writeFile(join(directory, "inline.ts"), buildInline);
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        allowArbitraryExtensions: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      include: ["*.ts", "*.mts"],
    }),
  );
}
