import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { TextDocument } from "vscode-languageserver-textdocument";
import { installCatalogContractFixture } from "../../../test/helpers/catalog-contract-fixture.js";
import { ProtocolClient } from "../../../test/helpers/protocol-client.js";
import {
  type AnalysisRegistration,
  createAnalysisContextScope,
  defineAnalysisRegistration,
  exportQueryContracts,
  loadQueryContracts,
  openAnalysisCache,
  queryContractDigest,
} from "../../analysis/src/index.js";
import { context, fixture } from "../../cli/test/helpers/contract-fixture.js";
import { loadConfigSource } from "../../config/src/index.js";
import { TypedSqlLanguageService } from "../src/index.js";

const document = (directory: string, source: string, sql = false) =>
  TextDocument.create(
    pathToFileURL(join(directory, sql ? "src/value.sql" : "src/query.ts")).href,
    sql ? "sql" : "typescript",
    1,
    source,
  );
const service = (directory: string) => new TypedSqlLanguageService(directory, { nativePreview: false });
await describe("recorded contracts in the editor", async () => {
  await it("checks catalog-bound contracts using the enriched schema and rejects changed interpreters", async () => {
    await fixture(async (directory) => {
      const loaded = await loadConfigSource({ cwd: directory });
      const artifacts = join(directory, "generated/contracts");
      const contracts = await loadQueryContracts(artifacts);
      const closure = await installCatalogContractFixture({
        directory,
        contractsDirectory: artifacts,
        profile: loaded.config.dialect,
        schema: loaded.config.dialect.validateSnapshot(
          JSON.parse(await readFile(join(directory, "schema.json"), "utf8")),
        ),
        configuration: defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration),
        queries: [{ sql: "SELECT $1::bigint AS value", valuePlan: contracts[0]!.valuePlan }],
      });
      const current = service(directory);
      try {
        const ts = document(directory, await readFile(join(directory, "src/query.ts"), "utf8"));
        const before = await current.analysis(ts);
        strict.deepEqual(before?.diagnostics, []);
        strict.equal(before?.identity.schema.hash, closure.context.schemaHash);
        strict.ok((await current.watchedFiles()).includes(join(artifacts, "catalogs", `${closure.digest}.json`)));
        strict.match(JSON.stringify(await current.hover(ts, ts.positionAt(ts.getText().indexOf("SELECT")))), /bigint/u);
        const owner = join(directory, "catalog-owner.mjs");
        strict.ok((await current.watchedFiles()).includes(owner));
        const configPath = join(directory, "typed-sql.config.mjs");
        const frozenConfig = await readFile(configPath, "utf8");
        await writeFile(configPath, frozenConfig.replace('mode:"frozen"', 'mode:"offline"'));
        current.invalidate();
        const offline = await current.analysis(ts);
        strict.deepEqual(offline?.diagnostics, []);
        strict.equal(offline?.identity.schema.hash, closure.context.schemaHash);
        const cache = await openAnalysisCache({
          directory: join(directory, ".typed-sql/cache/analysis/v1"),
          workspaceContext: queryContractDigest({ workspace: loaded.directory, config: loaded.file }),
        });
        await cache.retireContext(context);
        await strict.rejects(current.analysis(ts), /catalog context is stale/u);
        await writeFile(configPath, frozenConfig);
        current.invalidate();
        await writeFile(owner, (await readFile(owner, "utf8")).replace('"integer"', '"text"'));
        current.invalidate();
        await strict.rejects(current.analysis(ts), /installed interpretation/u);
        if (before) strict.equal(current.isAnalysisCurrent(ts, before), false);
      } finally {
        await current.close();
      }
    });
  });
  await it("checks templates and raw SQL with cold factories and ignores corrupt disposable state in frozen mode", async () => {
    await fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          'analysis:{mode:"frozen",',
          'analysis:{mode:"frozen",live:{adapter(){throw Error("native factory must remain cold")}},',
        ),
      );
      const cache = join(directory, ".typed-sql/cache/analysis/v1");
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, "ownership.json"), "corrupt disposable state");
      const current = service(directory);
      try {
        const source = await readFile(join(directory, "src/query.ts"), "utf8");
        const ts = document(directory, source);
        strict.deepEqual(await current.diagnostics(ts), []);
        strict.match(JSON.stringify(await current.hover(ts, ts.positionAt(source.indexOf("SELECT")))), /bigint/u);
        const sql = document(directory, "SELECT :id::bigint AS value", true);
        strict.deepEqual(await current.diagnostics(sql), []);
        strict.match(JSON.stringify(await current.hover(sql, { line: 0, character: 8 })), /bigint/u);
        const watched = await current.watchedFiles();
        strict.ok(watched.includes(join(directory, "generated/contracts/manifest.json")));
        strict.ok(!watched.some((path) => path.includes("/indexes/")));
      } finally {
        await current.close();
      }
    });
  });
  await it("rechecks changed durable closures even when document text and version are unchanged", async () => {
    await fixture(async (directory) => {
      const current = service(directory);
      try {
        const ts = document(directory, await readFile(join(directory, "src/query.ts"), "utf8"));
        const initial = await current.analysis(ts);
        strict.ok(initial);
        strict.deepEqual(initial?.diagnostics, []);
        await exportQueryContracts(join(directory, "generated/contracts"), []);
        const changed = await current.analysis(ts);
        strict.notEqual(changed?.revision, initial?.revision);
        strict.ok(changed?.diagnostics.some((diagnostic) => diagnostic.code === "TSQ406"));
        if (initial) strict.equal(current.isAnalysisCurrent(ts, initial), false);
      } finally {
        await current.close();
      }
    });
  });
  await it("retires a prior editor result when a durable object becomes corrupt", async () => {
    await fixture(async (directory) => {
      const current = service(directory);
      try {
        const ts = document(directory, await readFile(join(directory, "src/query.ts"), "utf8"));
        const before = await current.analysis(ts);
        if (!before) throw Error("Missing initial analysis");
        const contracts = await loadQueryContracts(join(directory, "generated/contracts"));
        await writeFile(
          join(directory, "generated/contracts/queries", `${contracts[0]!.digest}.json`),
          "corrupt immutable object",
        );
        await strict.rejects(current.analysis(ts));
        strict.equal(current.isAnalysisCurrent(ts, before), false);
      } finally {
        await current.close();
      }
    });
  });
  await it("uses durable contracts offline, and loads static rules only for hybrid misses", async () => {
    await fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      const offline = (await readFile(config, "utf8")).replace('mode:"frozen"', 'mode:"offline"');
      await writeFile(config, offline);
      const current = service(directory);
      try {
        const ts = document(directory, await readFile(join(directory, "src/query.ts"), "utf8"));
        strict.deepEqual(await current.diagnostics(ts), []);
        await exportQueryContracts(join(directory, "generated/contracts"), []);
        await strict.rejects(current.analysis(ts), /analyzer must remain cold/u);
        await writeFile(
          config,
          offline.replace(
            'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
            'loadAnalyzer:async()=>(await import("@typed-sql/postgres/analysis")).postgres()',
          ),
        );
        current.invalidate();
        strict.deepEqual(await current.diagnostics(ts), []);
        await writeFile(config, offline.replace('mode:"hybrid"', 'mode:"native-required"'));
        current.invalidate();
        strict.ok((await current.diagnostics(ts)).some((diagnostic) => diagnostic.code === "TSQ406"));
      } finally {
        await current.close();
      }
    });
  });
  await it("resolves a scoped durable context without a pin and rejects a different target", async () => {
    await fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      const target = {
        connectionContext: queryContractDigest("editor-target"),
        adapter: { id: "vendor/native", version: "1" },
      };
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          `context:${JSON.stringify(context)},`,
          `cache:${JSON.stringify(target)},`,
        ),
      );
      const loaded = await loadConfigSource({ file: config });
      const schema = loaded.config.dialect.validateSnapshot(
        JSON.parse(await readFile(join(directory, "schema.json"), "utf8")),
      );
      const { live: _live, ...configuration } = defineAnalysisRegistration(
        loaded.config.analysis as AnalysisRegistration,
      );
      const scope = createAnalysisContextScope({ profile: loaded.config.dialect, schema, configuration });
      const contracts = await loadQueryContracts(join(directory, "generated/contracts"));
      await exportQueryContracts(join(directory, "generated/contracts"), contracts, { selection: { scope, context } });
      const current = service(directory);
      try {
        const ts = document(directory, await readFile(join(directory, "src/query.ts"), "utf8"));
        strict.deepEqual(await current.diagnostics(ts), []);
        await writeFile(
          config,
          (await readFile(config, "utf8")).replace(target.connectionContext, queryContractDigest("other-target")),
        );
        current.invalidate();
        await strict.rejects(current.analysis(ts), /target scope/u);
      } finally {
        await current.close();
      }
    });
  });
  await it("rejects incomplete live editor registration before constructing native resources", async () => {
    await fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          'analysis:{mode:"frozen",',
          'analysis:{mode:"live",live:{adapter(){throw Error("native factory must remain cold")}},',
        ),
      );
      const current = service(directory);
      try {
        const ts = document(directory, await readFile(join(directory, "src/query.ts"), "utf8"));
        await strict.rejects(current.analysis(ts), /explicit native adapter and cache target/u);
      } finally {
        await current.close();
      }
    });
  });
  await it("publishes contract-derived types through the built stdio server in offline and frozen modes", async () => {
    for (const mode of ["offline", "frozen"])
      await fixture(async (directory) => {
        const config = join(directory, "typed-sql.config.mjs");
        await writeFile(config, (await readFile(config, "utf8")).replace('mode:"frozen"', `mode:"${mode}"`));
        const file = join(directory, "src/query.ts");
        const source = `${await readFile(file, "utf8")}
import type {Query} from "@typed-sql/core";
const statement=query(1n);
type Row=typeof statement extends Query<infer Value, infer _Params> ? Value : never;
const wrong:Row={value:"wrong"};`;
        await writeFile(file, source);
        const server = fileURLToPath(new URL("../dist/packages/language-server/src/server.js", import.meta.url));
        const client = new ProtocolClient(process.execPath, [server, "--stdio"], directory);
        const uri = pathToFileURL(file).href;
        try {
          await client.request("initialize", {
            processId: null,
            rootUri: pathToFileURL(directory).href,
            capabilities: { textDocument: { diagnostic: {} } },
            initializationOptions: { nativePreview: false },
          });
          client.notify("initialized", {});
          client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "typescript", version: 1, text: source },
          });
          const response = (await client.request("textDocument/diagnostic", { textDocument: { uri } })) as {
            items: { message: string; code?: string | number }[];
          };
          strict.ok(
            response.items.some((item) => /string.*not assignable.*bigint/u.test(item.message)),
            JSON.stringify(response),
          );
          strict.ok(
            !response.items.some((item) => /TSQ406|analysis is unavailable/u.test(item.message)),
            JSON.stringify(response),
          );
        } finally {
          await client.close();
        }
      });
  });
});
