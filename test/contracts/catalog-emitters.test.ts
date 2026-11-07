import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { addCapture, emptyCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { generateCatalogs } from "../../scripts/catalog-generation/generate.mjs";
import { CATEGORIES, inventory, unavailable } from "../../scripts/language-audit/inventory.mjs";
import { scalarTypeName } from "../../tools/grammar-catalog/src/generate/duckdb.mjs";
import { routineSignature } from "../../tools/grammar-catalog/src/model/routines.mjs";
import { createMapperRegistry, numericVersionBand } from "../../tools/grammar-catalog/src/registry.mjs";

const execFile = promisify(execFileCallback);
const workspace = fileURLToPath(new URL("../../", import.meta.url));
interface EmitterContext {
  header: string;
  groups: { categories: Record<string, { rows?: { name: string }[] }> }[];
  emit(path: string, text: string): Promise<void>;
  input(key: string, path: string): Promise<unknown>;
}
type Emitter = (context: EmitterContext) => Promise<void>;
const mapper = {
  id: "external",
  versionBand: numericVersionBand(1),
  normalizeRow: (_category: string, row: unknown) => row,
  routineFacts: () => ({ parameters: [], result: "external_type" }),
};
async function fixture(generateCatalog?: Emitter) {
  const registry = createMapperRegistry([{ ...mapper, ...(generateCatalog ? { generateCatalog } : {}) }]);
  const native = { name: "external_function" };
  const row = { ...native, signature: routineSignature(mapper, native) };
  const corpus = emptyCorpus();
  await addCapture(
    corpus,
    {
      dialect: "external",
      target: { version: "1.0.0" },
      categories: Object.fromEntries(
        CATEGORIES.map((name) => [
          name,
          name === "functions" ? inventory([row], "external capture") : unavailable("No fixture observation"),
        ]),
      ),
    },
    registry,
  );
  return { corpus, registry };
}

await describe("registered catalog emitters and clean generation", async () => {
  await it("generates an external grammar deterministically through the shared runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-emitter-"));
    try {
      await writeFile(join(root, "policy.json"), JSON.stringify({ policy: "external" }));
      const { corpus, registry } = await fixture(async ({ groups, emit, input, header }) => {
        const names = groups.flatMap((group) => group.categories.functions?.rows ?? []).map((row) => row.name);
        const policy = await input("policy", "policy.json");
        await emit("generated/catalog.mjs", `${header}export const catalog = ${JSON.stringify({ names, policy })};\n`);
      });
      const options = { root, registry };
      const first = await generateCatalogs(corpus, options);
      strict.ok(first.changed.includes("generated/catalog.mjs"));
      const generated = await readFile(join(root, "generated/catalog.mjs"), "utf8");
      strict.ok(generated.includes("external_function"));
      strict.ok(generated.includes('"policy":"external"'));
      strict.deepEqual((await generateCatalogs(corpus, { ...options, check: true })).changed, []);
      const report = JSON.parse(await readFile(join(root, "grammar/catalog/generation.json"), "utf8"));
      strict.equal(report.outputDigestFormat, "utf8-bytes-sha256");
      strict.match(report.outputDigests["generated/catalog.mjs"], /^sha256:[a-f0-9]{64}$/u);
      await writeFile(join(root, "generated/catalog.mjs"), "changed by hand");
      await strict.rejects(generateCatalogs(corpus, { ...options, check: true }), /stale/u);
      strict.equal(await readFile(join(root, "generated/catalog.mjs"), "utf8"), "changed by hand");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await it("validates all contributions before writing and rejects conflicting or reserved ownership", async () => {
    for (const behavior of [
      "failure",
      "duplicate",
      "case-collision",
      "report",
      "schema",
      "escape",
      "absolute",
      "missing",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "typed-sql-emitter-invalid-"));
      try {
        const { corpus, registry } = await fixture(
          behavior === "missing"
            ? undefined
            : async ({ emit }) => {
                await emit("generated/value.mjs", "export const value = 1;\n");
                if (behavior === "failure") throw new Error("Invalid mapping contribution");
                const path = {
                  duplicate: "generated/value.mjs",
                  "case-collision": "generated/VALUE.mjs",
                  report: "grammar/catalog/generation.json",
                  schema: "grammar/catalog/format.schema.json",
                  escape: "../outside.mjs",
                  absolute: "/outside.mjs",
                }[behavior];
                await emit(path, "invalid ownership");
              },
        );
        await strict.rejects(
          generateCatalogs(corpus, { root, registry }),
          /mapping contribution|multiple emitters|workspace|Missing catalog emitter/u,
        );
        strict.deepEqual(await readdir(root), [], behavior);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  await it("uses fresh captured scalar aliases without reading a generated parser", () => {
    strict.equal(scalarTypeName("new_alias", { NEW_ALIAS: "FRESH_NATIVE_TYPE" }, {}), "FRESH_NATIVE_TYPE");
    strict.equal(scalarTypeName("DECIMAL(18,3)", {}, {}), "DECIMAL");
    strict.equal(scalarTypeName("TIME WITH TIME ZONE", {}, { "TIME WITH TIME ZONE": "TIMETZ" }), "TIMETZ");
    for (const source of ["DECIMAL(39,0)", "DECIMAL(2,3)", "INTEGER[]", "MAP(INTEGER,VARCHAR)", "int);DROP TABLE t"])
      strict.throws(() => scalarTypeName(source, {}, {}), /endpoint/u);
  });

  await it("bootstraps all current outputs without grammar implementations or previously generated code", async () => {
    const root = await mkdtemp(join(tmpdir(), "typed-sql-catalog-bootstrap-"));
    try {
      for (const path of [
        "tools/grammar-catalog/src",
        "scripts/catalog-generation",
        "scripts/language-audit",
        "grammar",
      ])
        await cp(join(workspace, path), join(root, path), { recursive: true });
      await cp(join(workspace, "tools/grammar-catalog/package.json"), join(root, "tools/grammar-catalog/package.json"));
      const dependency = join(root, "tools/grammar-catalog/node_modules/@sinclair/typebox");
      await mkdir(dirname(dependency), { recursive: true });
      await symlink(
        await realpath(join(workspace, "tools/grammar-catalog/node_modules/@sinclair/typebox")),
        dependency,
        "junction",
      );
      await strict.rejects(access(join(root, "packages")), { code: "ENOENT" });
      await rm(join(root, "grammar/catalog/format.schema.json"));
      await rm(join(root, "grammar/catalog/generation.json"));
      const references = join(workspace, "test/fixtures/language-audit");
      for (const reference of (await readdir(references)).filter((name) => name.startsWith("sqlite-reference-"))) {
        const destination = join(root, "test/fixtures/language-audit", reference);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(references, reference), destination);
      }
      for (const mode of ["generate", "check"])
        await execFile(process.execPath, ["scripts/catalog-generation/run.mjs", mode], { cwd: root, timeout: 90_000 });
      const report = JSON.parse(await readFile(join(root, "grammar/catalog/generation.json"), "utf8"));
      for (const path of report.outputs) await access(join(root, path));
      const corpus = JSON.parse(await readFile(join(root, "grammar/catalog/upstream.json"), "utf8"));
      strict.equal(report.model.profiles, Object.keys(corpus.targets).length);
      await strict.rejects(access(join(root, "packages/duckdb/src/native-types.ts")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
