import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { postgres as compatibility } from "../src/analysis.js";
import { nativeSignatures } from "../src/catalog/generated/native.js";
import { postgres } from "../src/core-analysis.js";

const policy = JSON.parse(
  await readFile(new URL("../../../grammar/postgres/catalog/offline-core.json", import.meta.url), "utf8"),
);
const ledger = JSON.parse(await readFile(new URL("../../../grammar/features/ledger.json", import.meta.url), "utf8"));
const majors = [...ledger.dialects.postgres.stable, ...ledger.dialects.postgres.canary].map(
  ({ minimum, maximum }: { minimum: string; maximum: string }) => {
    strict.equal(minimum, maximum);
    return Number(minimum);
  },
);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await describe("compact PostgreSQL offline core and explicit compatibility packs", async () => {
  await it("retains complete selected overload families and succeeds on the reviewed workload corpus", async () => {
    strict.ok(policy.names.length <= policy.nameBudget);
    strict.equal(policy.selection.license, "MIT");
    const core = postgres({ versionPolicy: "canary" }),
      full = compatibility({ versionPolicy: "canary" });
    for (const major of majors) {
      for (const [entry, source] of [
        [`./analysis/core/profiles/${major}`, `analysis/core/generated/${major}`],
        [`./analysis/packs/compatibility/${major}`, `analysis/packs/generated/${major}`],
      ] as const) {
        strict.equal(manifest.exports[entry], `./dist/packages/postgres/src/${source}.js`);
        strict.ok(manifest.typedSql.developmentEntrypoints.includes(entry));
      }
      const module = await import(`../src/analysis/core/generated/${major}.js`);
      const data = await import(`../src/catalog/generated/offline/${major}.js`);
      strict.deepEqual(
        data.nativeSignatures,
        nativeSignatures[major]!.filter((row) => row.namespace === "pg_catalog" && policy.names.includes(row.name)),
      );
      const snapshot = { formatVersion: 1, dialect: "postgres", version: String(major), tables: {} } as const;
      for (const workload of policy.workloads) {
        const expected = full.analyze(workload.sql, snapshot);
        strict.deepEqual(expected.diagnostics, [], `${major} full: ${workload.scenario}`);
        strict.deepEqual(core.analyze(workload.sql, snapshot), expected, `${major} core: ${workload.scenario}`);
        strict.deepEqual(
          module.postgres({ versionPolicy: "canary" }).analyze(workload.sql, snapshot),
          expected,
          `${major} fixed core: ${workload.scenario}`,
        );
        strict.ok(
          expected.columns.every((column) => column.tsType !== "unknown" && column.tsType !== "any"),
          workload.scenario,
        );
      }
    }
  });
  await it("leaves the long tail conservative and restores complete compatibility only through an explicit pack", async () => {
    for (const major of majors) {
      const { compatibilityPack } = await import(`../src/analysis/packs/generated/${major}.js`);
      const snapshot = { formatVersion: 1, dialect: "postgres", version: String(major), tables: {} } as const;
      const sql = "SELECT pg_backend_pid() AS process";
      const core = postgres({ versionPolicy: "canary" }).analyze(sql, snapshot);
      strict.ok(core.diagnostics.some((row) => row.code === "TSQ202"));
      strict.equal(core.columns[0]?.tsType, "unknown");
      strict.equal(compatibilityPack.major, major);
      strict.deepEqual(
        compatibilityPack.signatures,
        nativeSignatures[major]!.filter((row) => !(row.namespace === "pg_catalog" && policy.names.includes(row.name))),
      );
      strict.ok(Object.isFrozen(compatibilityPack.signatures[0].arguments));
      const packed = postgres({ versionPolicy: "canary", packs: [compatibilityPack, compatibilityPack] });
      strict.deepEqual(
        packed.analyze(sql, snapshot),
        compatibility({ versionPolicy: "canary" }).analyze(sql, snapshot),
      );
      for (const workload of policy.workloads)
        strict.deepEqual(
          packed.analyze(workload.sql, snapshot),
          compatibility({ versionPolicy: "canary" }).analyze(workload.sql, snapshot),
        );
    }
  });
  await it("rejects incompatible pack revisions, versions, dependencies and conflicting signature evidence", async () => {
    const major = majors[0]!,
      { compatibilityPack } = await import(`../src/analysis/packs/generated/${major}.js`);
    const fixed = await import(`../src/analysis/core/generated/${major}.js`);
    for (const altered of [
      { ...compatibilityPack, grammarVersion: "different" },
      { ...compatibilityPack, catalogRevision: `sha256:${"0".repeat(64)}` },
      { ...compatibilityPack, major: 0 },
      { ...compatibilityPack, sourceDigest: "unqualified" },
      { ...compatibilityPack, dependencies: [{ id: "unavailable-pack", digest: `sha256:${"0".repeat(64)}` }] },
      {
        ...compatibilityPack,
        signatures: [
          ...compatibilityPack.signatures,
          ...compatibilityPack.signatures
            .filter((row: { name: string }) => row.name === "pg_backend_pid")
            .map((row: { name: string; result: string }) =>
              row.name === "pg_backend_pid" ? { ...row, result: "text" } : row,
            ),
        ],
      },
    ])
      strict.throws(() => fixed.postgres({ packs: [altered] }), TypeError);
    const other = await import(`../src/analysis/packs/generated/${majors[1]}.js`);
    strict.throws(() => fixed.postgres({ packs: [other.compatibilityPack] }), TypeError);
  });
});
