import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectSourceQueryCandidates, collectSqlFileQueryCandidates } from "../../packages/compiler/src/index.ts";
import { calculateSchemaHash } from "../../packages/schema/src/index.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { analyzeSqlFiles } from "../../website/.vitepress/theme/playground/workspace-sql.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ledger = JSON.parse(await readFile(join(root, "grammar/features/ledger.json"), "utf8"));
const profiles = [];
let transportFactoryCalls = 0;
const denied = async () => {
  transportFactoryCalls++;
  throw Error("Admission auditing must not initialize native services");
};
const owner = (module, suffix) => {
  const names = Object.keys(module).filter((name) => name.endsWith(suffix) && typeof module[name] === "function");
  assert.equal(names.length, 1, `Ambiguous ${suffix} owner`);
  return { name: names[0], factory: module[names[0]] };
};
for (const grammar of Object.keys(ledger.dialects).sort()) {
  const manifest = JSON.parse(await readFile(join(root, `packages/${grammar}/package.json`), "utf8"));
  const load = (entry) => {
    const target = manifest.exports[entry];
    assert.equal(typeof target, "string", `Missing public ${grammar}${entry} export`);
    const prefix = `./dist/packages/${grammar}/src/`;
    assert.ok(target.startsWith(prefix) && target.endsWith(".js"), `Unsupported export layout for ${grammar}${entry}`);
    return import(
      pathToFileURL(join(root, `packages/${grammar}/src`, target.slice(prefix.length).replace(/\.js$/u, ".ts"))).href
    );
  };
  const profile = owner(await load("./profile"), "Profile").factory();
  assert.equal(profile.id, grammar);
  const files = commerceFiles(grammar);
  const parsed = analyzeSqlFiles(grammar, files);
  assert.ok(parsed.snapshot && !parsed.problems.some((problem) => problem.severity === "error"));
  const schema = profile.validateSnapshot(parsed.snapshot);
  const version = schema.server?.versionKey ?? schema.version ?? "";
  const cores = Object.keys(manifest.exports).filter((entry) => {
    if (!/^\.\/analysis\/core(?:\/[^/]+)?$/u.test(entry)) return false;
    const selected = entry.slice("./analysis/core".length).replace(/^\//u, "");
    return !selected || version === selected || version.startsWith(`${selected}.`);
  });
  assert.equal(cores.length, 1, `Ambiguous selected core for ${grammar}/${version}`);
  const core = (await load(cores[0]))[grammar]();
  const entries = Object.keys(manifest.exports).filter(
    (entry) => entry.endsWith("-contracts") || entry === "./native-contracts",
  );
  const nativeEntry = entries.includes("./native-contracts") ? "./native-contracts" : entries[0];
  assert.ok(
    nativeEntry && (entries.length === 1 || nativeEntry === "./native-contracts"),
    `Ambiguous native export for ${grammar}`,
  );
  const native = owner(await load(nativeEntry), "NativeContractAdapter");
  // Discovery uses public owner factories. Only accept() is called; all supplied transports fail.
  let adapter;
  let availability = { status: "available" };
  try {
    adapter = native.factory({
      schema,
      pool: { connect: denied, acquire: denied },
      connectionUri: "mysql://native-admission.invalid/unused",
      path: join(tmpdir(), `typed-sql-native-admission-never-opened-${process.pid}.sqlite`),
      driverImporter: denied,
      sdkImporter: denied,
    });
    assert.equal(typeof adapter.accept, "function");
    assert.equal(adapter.grammar.id, grammar);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    availability = { status: "unavailable", reason: error.message };
  }
  const queries = [];
  for (const [file, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.startsWith("queries/") || !/\.(?:ts|sql)$/u.test(file)) continue;
    const collection = (file.endsWith(".sql") ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source,
      schema,
      profile,
    });
    queries.push({
      file,
      sourceDigest: hash(source),
      complete: collection.complete,
      collectionDiagnostics: collection.diagnostics,
      candidates: collection.candidates.map((candidate) => {
        const analysis = core.analyze(candidate.sql, schema);
        return {
          sql: candidate.sql,
          sqlDigest: hash(candidate.sql),
          parameterOccurrences: candidate.parameterOccurrences,
          logicalBindings: candidate.logicalBindings,
          logicalParameterCount: candidate.logicalParameterCount,
          staticColumnCount: analysis.columns.length,
          staticParameters: analysis.parameters,
          staticDiagnostics: analysis.diagnostics,
          admission: !collection.complete
            ? { accepted: null, reason: "collection-incomplete" }
            : adapter
              ? adapter.accept({ sql: candidate.sql, parameterOccurrences: candidate.parameterOccurrences })
              : { accepted: null, reason: "native-environment-evidence-unavailable" },
          nativeQualification: "not-attempted",
        };
      }),
    });
  }
  const finite = queries.filter((query) => query.complete).flatMap((query) => query.candidates);
  profiles.push({
    grammar,
    exampleServer: schema.server ?? { version: schema.version ?? "unknown" },
    coreEntry: cores[0],
    nativeEntry,
    nativeFactory: native.name,
    adapter: adapter ? { id: adapter.id, version: adapter.version } : null,
    availability,
    schemaOrigin: "Maintained example DDL parser; not a live catalog",
    schemaDigest: calculateSchemaHash(schema),
    corpusInputs: Object.fromEntries(Object.entries(files).map(([file, source]) => [file, hash(source)])),
    summary: {
      finiteCandidates: finite.length,
      admitted: finite.filter((candidate) => candidate.admission.accepted).length,
      declined: finite.filter((candidate) => candidate.admission.accepted === false).length,
      unavailable: finite.filter((candidate) => candidate.admission.accepted === null).length,
      staticErrorCandidates: finite.filter((candidate) =>
        candidate.staticDiagnostics.some((diagnostic) => diagnostic.severity === "error"),
      ).length,
      incompleteFiles: queries.filter((query) => !query.complete).length,
    },
    queries,
  });
}
assert.equal(transportFactoryCalls, 0);
const report = {
  formatVersion: 1,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  toolDigest: hash(await readFile(fileURLToPath(import.meta.url))),
  librarySourcesDirty:
    execFileSync("git", ["status", "--porcelain", "--", "packages", "examples", "website"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0,
  scope:
    "Syntactic admission of the unmodified maintained commerce corpus. Acceptance is not native preparation, binding safety, descriptor availability or project qualification. No database is contacted.",
  transportFactoryCalls,
  networkDenial: {
    installed: typeof globalThis[Symbol.for("typed-sql.test.networkAttempts")] === "number",
    attempts: globalThis[Symbol.for("typed-sql.test.networkAttempts")] ?? null,
    ipcAttempts: globalThis[Symbol.for("typed-sql.test.deniedIpcAttempts")] ?? null,
  },
  profiles,
};
const destination = resolve(process.argv[2] ?? join(root, "planning/hybrid-analysis/native-admission.json"));
assert.ok(destination.endsWith(".json"), "Admission report requires a .json destination");
const formatted = execFileSync(
  join(root, "node_modules/.bin/biome"),
  ["format", "--stdin-file-path=native-admission.json"],
  { cwd: root, input: JSON.stringify(report), maxBuffer: 4 * 1024 * 1024 },
);
await writeFile(destination, formatted);
const rows = profiles.map(
  (profile) =>
    `| ${profile.grammar} | ${profile.summary.finiteCandidates} | ${profile.summary.admitted} | ${profile.summary.declined} | ${profile.summary.unavailable} | ${profile.summary.incompleteFiles} |`,
);
const unavailable = profiles
  .filter((profile) => profile.availability.status === "unavailable")
  .map((profile) => `- ${profile.grammar}: ${profile.availability.reason}`)
  .join("\n");
await writeFile(
  destination.slice(0, -5) + ".md",
  `# Commerce native admission

Generated by [audit-native-admission.mjs](./audit-native-admission.mjs) from the machine-readable
admission report. Source revision: \`${report.sourceRevision}\`. Library/corpus sources modified:
\`${report.librarySourcesDirty}\`. This audits the unmodified maintained commerce queries discovered
for every grammar in the feature ledger. Public export metadata selects each core/native owner;
there is no copied function list or per-grammar query list.

**Admission is not native qualification.** This pass opens no database and neither prepares
queries nor proves live binding safety, result descriptors or project-wide native support.
Supplied native service factories were called ${transportFactoryCalls} times. Node network denial
installed: ${report.networkDenial.installed}; TCP/DNS/fetch attempts: ${report.networkDenial.attempts ?? "not measured"}.
This is a Node-process boundary, not OS network isolation.

| Grammar | Finite candidates | Admission passes | Admission declines | Evidence unavailable | Incomplete files |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

The example schemas come from the maintained DDL parser, not live introspection. Missing native
environment evidence remains unavailable. No default settings or schema facts are invented.
Constructor evidence gaps:

${unavailable || "None in the recorded examples."}

Incomplete rendering is excluded from native admission, with candidate diagnostics retained in JSON. The report records
exact SQL/digests, parameter occurrences, static parameter evidence and every admission decision.

All ${profiles.reduce((sum, profile) => sum + profile.summary.finiteCandidates, 0)} finite candidates have
${profiles.reduce((sum, profile) => sum + profile.summary.staticErrorCandidates, 0)} static-analysis errors
in this pass. Existing offline support does not imply that the guarded native producers can
qualify the same workload. Declines expose statement/binding restrictions to investigate before
claiming advanced project coverage. Real schema provisioning, native reconciliation and scaling
measurements remain separate work.

Reproduce after a workspace build:

\`\`\`sh
node --import tsx planning/hybrid-analysis/audit-native-admission.mjs
\`\`\`

The repository contract runs this command with a preloaded network-denial trap and checks every
declared grammar, maintained query file, result partition and parameter occurrence. Native
initialization or an attempted network request fails that check.
`,
);
for (const profile of profiles) console.log(JSON.stringify({ grammar: profile.grammar, ...profile.summary }));
