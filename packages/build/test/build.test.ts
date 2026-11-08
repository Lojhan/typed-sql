import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { describe, it, strict } from "poku";
import { buildInline, buildSnapshot, prepareBuildProject } from "../../../test/helpers/build-project.js";
import { createQueryContract, exportQueryContracts, queryContractDigest } from "../../analysis/src/index.js";
import { collectSqlFileQueryCandidates } from "../../compiler/src/index.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../schema/src/index.js";
import { sqliteProfile, typePolicy } from "../../sqlite/src/profile.js";
import { BuildError, BuildSession, generateSqlTypes, loadBuildProject } from "../src/index.js";
import { createTransformer } from "../src/jest-transformer.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-build-unit-"));
  try {
    await prepareBuildProject(directory);
    await mkdir(join(directory, "node_modules/@typed-sql"), { recursive: true });
    await symlink(
      join(workspace, "packages/sqlite"),
      join(directory, "node_modules/@typed-sql/sqlite"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await describe("stable build compiler", async () => {
  await it("builds frozen SQL and declarations without initializing analysis or live services, and invalidates artifact changes", async () =>
    fixture(async (cwd) => {
      const policy = { ...typePolicy, integer: "number" as const };
      const profile = sqliteProfile({ typePolicy: policy });
      const snapshot = profile.validateSnapshot(buildSnapshot);
      const identity = {
        profileHash: queryContractDigest("fixture-profile"),
        codecHash: queryContractDigest("fixture-codec"),
        interpreterHash: queryContractDigest("fixture-interpreter"),
      };
      const context = {
        grammar: { id: profile.id, version: profile.grammarVersion },
        ...identity,
        schemaHash: calculateSchemaHash(snapshot),
        typePolicyHash: calculateTypePolicyHash(policy),
        databaseContextHash: queryContractDigest("fixture-recorded-context"),
      };
      const source = await readFile(join(cwd, "query.sql"), "utf8");
      const sql = collectSqlFileQueryCandidates({ source, profile, schema: snapshot, typePolicy: policy })
        .candidates[0]!.sql;
      const contract = (nullable: boolean) =>
        createQueryContract({
          sql,
          context,
          origin: "offline-rule",
          valuePlan: {
            dialect: "sqlite",
            typePolicyHash: context.typePolicyHash,
            columns: [
              { name: "id", type: "number", nullable, databaseType: "INTEGER" },
              { name: "email", type: "string", nullable: false, databaseType: "TEXT" },
            ],
            parameters: [{ index: 1, type: "number", nullable: true, databaseType: "INTEGER" }],
          },
        });
      const artifacts = join(cwd, "contracts");
      await exportQueryContracts(artifacts, [contract(false)]);
      const configuration = {
        mode: "frozen",
        context,
        identity,
        qualification: {
          mode: "hybrid",
          owner: { id: "fixture/offline-owner", version: "1" },
          requiredNativeFacets: [],
        },
        contractsDir: "contracts",
      };
      const config = `import {sqliteProfile,typePolicy} from "@typed-sql/sqlite/profile";
export default {dialect:{...sqliteProfile({typePolicy:{...typePolicy,integer:"number"}}),loadAnalyzer(){throw Error("Recorded build initialized an analyzer");}},schema:{file:"schema.json",provider:{introspect(){throw Error("Build initialized a provider");}}},outDir:"generated",analysis:{...${JSON.stringify(configuration)},live:{adapter(){throw Error("Build initialized native services");}}}};`;
      await writeFile(join(cwd, "typed-sql.config.mjs"), config);
      const session = new BuildSession({ cwd });
      const first = await session.transform(source, join(cwd, "query.sql"));
      strict.ok(first?.dependencies.includes(join(await realpath(artifacts), "manifest.json")));
      strict.ok(first?.dependencies.some((path) => path.includes(`${sep}queries${sep}`)));
      await generateSqlTypes({ cwd });
      strict.match(await readFile(join(cwd, "query.d.sql.ts"), "utf8"), /"id": number/u);
      await exportQueryContracts(artifacts, [contract(true)]);
      const second = await session.transform(source, join(cwd, "query.sql"));
      strict.notEqual(first?.cacheKey, second?.cacheKey);
      strict.notEqual(first?.code, second?.code);
      await strict.rejects(generateSqlTypes({ cwd, check: true }), /TSQ_BUILD_TYPES_STALE/u);
      await generateSqlTypes({ cwd });
      strict.match(await readFile(join(cwd, "query.d.sql.ts"), "utf8"), /"id": number \| null/u);
      await strict.rejects(session.transform("SELECT id FROM account", join(cwd, "unrecorded.sql")), /TSQ406/u);
      const queryObject = second!.dependencies.find((path) => path.includes(`${sep}queries${sep}`))!;
      await writeFile(queryObject, "{}");
      await strict.rejects(session.transform(source, join(cwd, "query.sql")), /contract|fields/iu);
    }));

  await it("uses offline rules for unrecorded queries in live-configured builds and tracks lazy owner dependencies", async () =>
    fixture(async (cwd) => {
      const policy = { ...typePolicy, integer: "number" as const };
      const profile = sqliteProfile({ typePolicy: policy });
      const snapshot = profile.validateSnapshot(buildSnapshot);
      const context = {
        grammar: { id: profile.id, version: profile.grammarVersion },
        profileHash: queryContractDigest("fixture-profile"),
        codecHash: queryContractDigest("fixture-codec"),
        interpreterHash: queryContractDigest("fixture-interpreter"),
        schemaHash: calculateSchemaHash(snapshot),
        typePolicyHash: calculateTypePolicyHash(policy),
        databaseContextHash: queryContractDigest("fixture-context"),
      };
      await writeFile(
        join(cwd, "owner.mjs"),
        `import {sqlite} from "@typed-sql/sqlite/analysis"; export const owner=sqlite({typePolicy:${JSON.stringify(policy)}});`,
      );
      const configuration = {
        mode: "live",
        context,
        identity: {
          profileHash: context.profileHash,
          codecHash: context.codecHash,
          interpreterHash: context.interpreterHash,
        },
        qualification: {
          mode: "hybrid",
          owner: { id: "fixture/offline-owner", version: "1" },
          requiredNativeFacets: [],
        },
      };
      await writeFile(
        join(cwd, "typed-sql.config.mjs"),
        `import {sqliteProfile} from "@typed-sql/sqlite/profile";export default {dialect:{...sqliteProfile({typePolicy:${JSON.stringify(policy)}}),async loadAnalyzer(){return (await import("./owner.mjs")).owner;}},schema:{file:"schema.json"},outDir:"generated",analysis:{...${JSON.stringify(configuration)},live:{adapter(){throw Error("Build opened native services");}}}};`,
      );
      const session = new BuildSession({ cwd });
      const source = await readFile(join(cwd, "query.sql"), "utf8"),
        file = join(cwd, "query.sql");
      const first = await session.transform(source, file);
      strict.ok(first?.dependencies.includes(await realpath(join(cwd, "owner.mjs"))));
      strict.ok(
        first?.dependencies.includes(join(await realpath(cwd), "generated/contracts/manifest.json")),
        "A missing manifest remains a watched input",
      );
      const identity = await session.identity(source, file);
      await writeFile(
        join(cwd, "owner.mjs"),
        `${await readFile(join(cwd, "owner.mjs"), "utf8")}\n// owner source changed\n`,
      );
      strict.notEqual((await session.identity(source, file)).key, identity.key);
      strict.notEqual((await session.transform(source, file))?.cacheKey, first?.cacheKey);
      await generateSqlTypes({ cwd });
    }));
  await it("maps original Unicode positions through executable metadata and reuses only matching inputs", async () =>
    fixture(async (cwd) => {
      const session = new BuildSession({ cwd, cacheSize: 1 });
      const file = join(cwd, "inline.ts");
      const first = await session.transform(buildInline, file);
      strict.ok(first);
      strict.ok(first!.code.includes(".__typed"));
      strict.equal(await session.transform(buildInline, file), first);
      const generated = first!.code.indexOf("${id}") + 2;
      const original = buildInline.indexOf("${id}") + 2;
      const prefix = first!.code.slice(0, generated);
      const position = originalPositionFor(new TraceMap(first!.map), {
        line: prefix.split("\n").length,
        column: prefix.length - prefix.lastIndexOf("\n") - 1,
      });
      const before = buildInline.slice(0, original);
      strict.equal(position.line, before.split("\n").length);
      strict.equal(position.column, before.length - before.lastIndexOf("\n") - 1);
      await writeFile(
        join(cwd, "schema.json"),
        JSON.stringify({
          ...buildSnapshot,
          tables: {
            account: {
              ...buildSnapshot.tables.account,
              columns: {
                ...buildSnapshot.tables.account.columns,
                email: { ...buildSnapshot.tables.account.columns.email, nullable: true },
              },
            },
          },
        }),
      );
      const second = await session.transform(buildInline, file);
      strict.notEqual(second!.cacheKey, first!.cacheKey);
      strict.ok(second!.code.includes('"nullable":true'));
      await writeFile(join(cwd, "policy.mjs"), 'export const integer = "bigint";\n');
      strict.notEqual((await session.transform(buildInline, file))!.cacheKey, second!.cacheKey);
    }));

  await it("returns original SQL diagnostics and does not load config for unrelated source", async () =>
    fixture(async (cwd) => {
      const session = new BuildSession({ cwd });
      await strict.rejects(
        session.transform("SELECT '😀' AS emoji,\n missing FROM account", join(cwd, "invalid.sql")),
        (error: unknown) => {
          strict.ok(error instanceof BuildError);
          strict.equal((error as BuildError).diagnostics[0]!.line, 2);
          strict.equal((error as BuildError).diagnostics[0]!.code, "TSQ101");
          return true;
        },
      );
      strict.equal(
        await new BuildSession({ cwd, config: "missing.mjs" }).transform(
          "export const other = 1;",
          join(cwd, "other.ts"),
        ),
        null,
      );
      strict.equal(session.accepts(await realpath(join(cwd, "query.sql"))), true);
      strict.equal(session.accepts(join(cwd, "query.sql?raw")), false);
      const fileOnly = new BuildSession({ cwd, inline: false, config: "missing.mjs" });
      strict.equal(fileOnly.accepts(join(cwd, "plain.ts")), true);
      strict.equal(await fileOnly.transform("const value: number = 1", join(cwd, "plain.ts")), null);
      strict.equal(session.accepts(join(cwd, "node_modules/other/query.sql")), false);
      strict.throws(() => new BuildSession({ cacheSize: -1 }), /cacheSize/u);
    }));

  await it("generates portable declarations, detects stale input and preserves application-owned files", async () =>
    fixture(async (cwd) => {
      const result = await generateSqlTypes({ cwd });
      strict.equal(result.files.length, 1);
      const file = join(cwd, "query.d.sql.ts");
      strict.match(await readFile(file, "utf8"), /readonly \[number\]/u);
      await generateSqlTypes({ cwd, check: true });
      const windows = (await readFile(file, "utf8")).replaceAll("\n", "\r\n");
      await writeFile(file, windows);
      await writeFile(join(cwd, "query.sql"), "SELECT id, email FROM account WHERE id = ?\r\n");
      await generateSqlTypes({ cwd, check: true });
      await generateSqlTypes({ cwd });
      strict.equal(await readFile(file, "utf8"), windows);
      await writeFile(join(cwd, "query.sql"), "SELECT email FROM account WHERE id = ?");
      await strict.rejects(generateSqlTypes({ cwd, check: true }), /TSQ_BUILD_TYPES_STALE/u);
      await generateSqlTypes({ cwd });
      await writeFile(join(cwd, "query.sql"), "SELECT missing FROM account");
      await strict.rejects(generateSqlTypes({ cwd }), /TSQ101/u);
      await strict.rejects(readFile(file), /ENOENT/u);
      await writeFile(join(cwd, "query.sql"), "SELECT email FROM account");
      await writeFile(file, "// application-owned\n");
      await strict.rejects(generateSqlTypes({ cwd }), /application-owned/u);
      strict.equal(await readFile(file, "utf8"), "// application-owned\n");
    }));

  await it("keeps schema/config identities independent of checkout paths", async () =>
    fixture(async (first) =>
      fixture(async (second) => {
        strict.equal((await loadBuildProject(first)).configIdentity, (await loadBuildProject(second)).configIdentity);
      }),
    ));

  await it("uses the same fresh config in synchronous and asynchronous Jest entrypoints", async () =>
    fixture(async (cwd) => {
      const transformer = await createTransformer({ cwd, inline: false });
      const file = join(cwd, "query.sql");
      const source = await readFile(file, "utf8");
      const caller = { supportsStaticESM: true, instrument: false, configString: "fixture", config: { rootDir: cwd } };
      const key = transformer.getCacheKey(source, file, caller);
      strict.equal(await transformer.getCacheKeyAsync(source, file, caller), key);
      const sync = transformer.process(source, file, caller);
      const async = await transformer.processAsync(source, file, caller);
      strict.equal(sync.code, async.code);
      await writeFile(join(cwd, "policy.mjs"), 'export const integer = "bigint";\n');
      strict.notEqual(transformer.getCacheKey(source, file, caller), key);
    }));
});
