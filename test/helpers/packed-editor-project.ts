import { execFile as callback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { strict } from "poku";
import { grammarCases } from "../editor-hub/cases.mjs";
import { ProtocolClient, positionAt } from "./protocol-client.js";

const execFile = promisify(callback);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export type PackedEditorDialect = "mysql" | "postgres" | "sqlite" | "sqlserver" | "duckdb";

async function writeEditorProject(
  consumer: string,
  dialect: "mysql" | "postgres" | "sqlite" | "sqlserver" | "duckdb",
): Promise<{ readonly directory: string; readonly queryFile: string; readonly source: string }> {
  const directory = join(consumer, `editor-${dialect}`);
  const queryFile = join(directory, "query.ts");
  const sqlModule = `@typed-sql/${dialect}`;
  const mappedList =
    dialect === "postgres"
      ? `
    import type { QueryParameters } from "@typed-sql/core";
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    declare const accounts: readonly { id: bigint; email: string }[];
    const mappedQuery = sql\`INSERT INTO users (id, email) VALUES \${accounts.map(
      (account) => sql.fragment\`(\${account.id}, \${account.email})\`,
    )} RETURNING id, email\`;
    const mappedRow: Equal<QueryRow<typeof mappedQuery>, { id: bigint; email: string }> = true;
    const mappedParameters: Equal<QueryParameters<typeof mappedQuery>, readonly (bigint | string)[]> = true;
    const jsonQuery = sql\`SELECT jsonb_build_object('id', id, 'email', email) AS document FROM users\`;
    const jsonRow: Equal<QueryRow<typeof jsonQuery>, { document: { id: number; email: string } }> = true;
    const invalidMappedQuery = sql\`INSERT INTO users (id, email) VALUES \${accounts.map(
      (account) => sql.fragment\`(\${account.email}, \${account.id})\`,
    )} RETURNING id\`;
    void [mappedQuery, mappedRow, mappedParameters, jsonQuery, jsonRow, invalidMappedQuery];
  `
      : "";
  const source = `
    import { sql } from "${sqlModule}";
    import type { QueryRow } from "@typed-sql/core";

    declare const includeStatus: boolean;
    declare function execute<Query>(query: Query): Promise<readonly QueryRow<Query>[]>;
    const simpleQuery = sql\`SELECT account.id, account.email FROM users AS account\`;
    const rows = await execute(simpleQuery);
    type Actual = (typeof rows)[number];
    const cteQuery = sql\`
      WITH selected_accounts AS (
        SELECT account.id, account.status FROM users AS account
      )
      SELECT selected_accounts.id, selected_accounts.status FROM selected_accounts
    \`;
    const conditionalQuery = sql\`
      SELECT account.id
        \${includeStatus ? sql.fragment\`, account.status\` : sql.empty}
      FROM users AS account
    \`;
    const invalidParameter = sql\`SELECT account.id FROM users AS account WHERE account.id = \${"wrong"}\`;
    void [simpleQuery, rows, cteQuery, conditionalQuery, invalidParameter];
    ${mappedList}
  `;
  await mkdir(directory);
  await writeFile(
    join(directory, "typed-sql.config.ts"),
    `
      import { defineConfig } from "@typed-sql/core";
      import { ${dialect}, typePolicy } from "${sqlModule}";
      const dialect = ${dialect}({ typePolicy });
      export default defineConfig({
        dialect,
        schema: { file: "schema.json" },
        outDir: "generated",
        projects: ["tsconfig.json"],
        typePolicy,
      });
    `,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2024",
        },
        include: ["query.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const nativeSpec = grammarCases.find((spec) => spec.id === dialect);
  const nativeSchema =
    dialect === "sqlserver" || dialect === "duckdb"
      ? {
          ...nativeSpec!.schema,
          tables: {
            users: {
              name: "users",
              schema: dialect === "sqlserver" ? "dbo" : "main",
              columns: {
                id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
                email: {
                  name: "email",
                  databaseType: dialect === "sqlserver" ? "nvarchar(100)" : "VARCHAR",
                  tsType: "string",
                  nullable: false,
                },
                status: {
                  name: "status",
                  databaseType: dialect === "sqlserver" ? "nvarchar(40)" : "VARCHAR",
                  tsType: "string",
                  nullable: false,
                },
              },
            },
          },
        }
      : undefined;
  await writeFile(
    join(directory, "schema.json"),
    nativeSchema
      ? JSON.stringify(nativeSchema)
      : dialect === "sqlite"
        ? `${JSON.stringify(
            {
              formatVersion: 1,
              dialect: "sqlite",
              dialectVersion: "1.0.0",
              tables: {
                users: {
                  schema: "main",
                  name: "users",
                  kind: "table",
                  strict: true,
                  withoutRowid: false,
                  indexes: [],
                  foreignKeys: [],
                  columns: {
                    id: { name: "id", databaseType: "INTEGER", tsType: "bigint", nullable: false },
                    email: { name: "email", databaseType: "TEXT", tsType: "string", nullable: false },
                    status: { name: "status", databaseType: "TEXT", tsType: "string", nullable: false },
                  },
                },
              },
            },
            null,
            2,
          )}\n`
        : await readFile(join(workspace, "e2e", dialect, "schema", "catalog.snapshot.json"), "utf8"),
  );
  await writeFile(queryFile, source);
  return { directory, queryFile, source };
}

async function initializeEditor(client: ProtocolClient, directory: string): Promise<void> {
  await client.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(directory).href,
    workspaceFolders: [{ uri: pathToFileURL(directory).href, name: "packed-consumer" }],
    capabilities: {},
  });
  client.notify("initialized", {});
}

async function hoverText(client: ProtocolClient, queryFile: string, source: string, binding: string): Promise<string> {
  const hover = await client.request("textDocument/hover", {
    textDocument: { uri: pathToFileURL(queryFile).href },
    position: positionAt(source, source.indexOf(binding)),
  });
  return JSON.stringify(hover);
}

/** Identical packed manifest, diagnostics, hover, reload and restart checks for all five grammars. */
export async function assertPackedEditorProject(
  consumer: string,
  dialect: PackedEditorDialect,
  isolatedEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const languageServer = join(consumer, "node_modules", ".bin", "typed-sql-language-server");
  const typedSql = join(consumer, "node_modules", ".bin", "typed-sql");
  const project = await writeEditorProject(consumer, dialect);
  const manifestRun = await execFile(typedSql, ["manifest"], {
    cwd: project.directory,
    env: isolatedEnvironment,
  });
  strict.ok(
    manifestRun.stdout.includes(`Generated ${dialect === "postgres" ? 7 : 4} queries (0 unresolved`),
    manifestRun.stdout,
  );
  const manifestSource = await readFile(join(project.directory, ".typed-sql", "queries.json"), "utf8");
  strict.ok(!manifestSource.includes(project.directory));
  strict.strictEqual(
    (JSON.parse(manifestSource) as { readonly queries: readonly unknown[] }).queries.length,
    dialect === "postgres" ? 7 : 4,
  );
  const uri = pathToFileURL(project.queryFile).href;
  const client = new ProtocolClient(languageServer, ["--stdio"], project.directory, isolatedEnvironment);
  try {
    await initializeEditor(client, project.directory);
    const diagnosticsReady = client.notification(
      "textDocument/publishDiagnostics",
      (params) => (params as { readonly uri?: string }).uri === uri,
    );
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: project.source },
    });
    await diagnosticsReady;
    const diagnostics = (await client.request("textDocument/diagnostic", {
      textDocument: { uri },
    })) as {
      readonly items?: readonly {
        readonly code?: number | string;
        readonly severity?: number;
        readonly message?: string;
        readonly range: { readonly start: { readonly line: number } };
      }[];
    };
    strict.ok(
      diagnostics.items?.some((diagnostic) => /not assignable to parameter of type/u.test(diagnostic.message ?? "")),
      `${dialect} must report the bad interpolation through TypeScript: ${JSON.stringify(diagnostics.items)}`,
    );

    const simple = await hoverText(client, project.queryFile, project.source, "simpleQuery");
    strict.ok(simple.includes("id: bigint"), simple);
    strict.ok(simple.includes("email: string"), simple);
    strict.ok(!simple.includes("unknown"), simple);
    const rows = await hoverText(client, project.queryFile, project.source, "rows");
    strict.ok(rows.includes("readonly"), rows);
    strict.ok(rows.includes("id: bigint"), rows);
    strict.ok(rows.includes("email: string"), rows);
    strict.ok(!rows.includes("unknown"), rows);
    const actual = await hoverText(client, project.queryFile, project.source, "Actual");
    strict.ok(actual.includes("id: bigint"), actual);
    strict.ok(actual.includes("email: string"), actual);
    strict.ok(!actual.includes("unknown"), actual);
    const cte = await hoverText(client, project.queryFile, project.source, "cteQuery");
    strict.ok(cte.includes("id: bigint"), cte);
    strict.ok(
      dialect === "sqlite" || dialect === "sqlserver" || dialect === "duckdb"
        ? cte.includes("status: string")
        : cte.includes('status: \\"active\\" | \\"suspended\\"'),
      cte,
    );
    const conditional = await hoverText(client, project.queryFile, project.source, "conditionalQuery");
    strict.ok(conditional.includes("id: bigint"), conditional);
    strict.ok(conditional.includes("status"), conditional);

    if (dialect === "postgres") {
      const callbackLine = positionAt(project.source, project.source.lastIndexOf("${account.email}")).line;
      strict.ok(
        diagnostics.items?.some(
          (diagnostic) =>
            diagnostic.range.start.line === callbackLine && /not assignable/u.test(diagnostic.message ?? ""),
        ),
        `swapped mapped-list callback must fail through packed declarations: ${JSON.stringify(diagnostics.items)}`,
      );
      strict.deepStrictEqual(
        diagnostics.items
          ?.filter((diagnostic) => diagnostic.severity === 1)
          .map((diagnostic) => diagnostic.range.start.line)
          .sort((a, b) => a - b),
        [positionAt(project.source, project.source.indexOf("const invalidParameter")).line, callbackLine],
        "Only the two intentional parameter errors may fail; mapped row and parameter types must match exactly",
      );
      const schemaFile = join(project.directory, "schema.json");
      const schema = JSON.parse(await readFile(schemaFile, "utf8")) as {
        tables: { users: { columns: { email: { nullable: boolean } } } };
      };
      schema.tables.users.columns.email.nullable = true;
      await writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
      const reloaded = client.notification(
        "textDocument/publishDiagnostics",
        (params) => (params as { readonly uri?: string }).uri === uri,
      );
      client.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(schemaFile).href, type: 2 }],
      });
      await reloaded;
      const changed = await hoverText(client, project.queryFile, project.source, "simpleQuery");
      const reloadDiagnostics = await client.request("textDocument/diagnostic", {
        textDocument: { uri },
      });
      strict.ok(
        changed.includes("email: string | null"),
        `${changed}\nReload diagnostics: ${JSON.stringify(reloadDiagnostics)}`,
      );
      strict.ok(changed.includes("id: bigint"), changed);

      const reconfigured = client.notification(
        "textDocument/publishDiagnostics",
        (params) => (params as { readonly uri?: string }).uri === uri,
      );
      client.notify("workspace/didChangeConfiguration", { settings: {} });
      await reconfigured;
      const afterConfiguration = await hoverText(client, project.queryFile, project.source, "simpleQuery");
      strict.ok(afterConfiguration.includes("email: string | null"), afterConfiguration);
    }
  } finally {
    await client.close();
  }

  if (dialect === "postgres") {
    const restarted = new ProtocolClient(languageServer, ["--stdio"], project.directory, isolatedEnvironment);
    try {
      await initializeEditor(restarted, project.directory);
      restarted.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: 1, text: project.source },
      });
      const hover = await hoverText(restarted, project.queryFile, project.source, "simpleQuery");
      strict.ok(hover.includes("email: string | null"), hover);
    } finally {
      await restarted.close();
    }
  }
}
