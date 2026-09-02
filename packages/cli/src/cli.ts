#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSchemaCompatibility,
  assertQueryVerificationProofCurrent,
  buildQueryManifest,
  captureQueryPlans,
  checkFile,
  collectQueryVerificationCandidates,
  listProjectSourceFiles,
  parseQueryManifest,
  parseQueryPlanArtifact,
  parseQueryVerificationProof,
  reviewQueryPlans,
  serializeQueryManifest,
  serializeQueryPlanArtifact,
  serializeQueryPlanReviewReport,
  serializeQueryVerificationProof,
  serializeSchemaCompatibilityReport,
  TYPESCRIPT_COMPILER_SUPPORT_POLICY,
  typeScriptCompilerVersionSupport,
  verifyQueryManifest,
} from "@typed-sql/compiler";
import { fromConfig, loadConfig } from "@typed-sql/config";
import { resolveDialectCapabilityStates, type SchemaSnapshot } from "@typed-sql/core";
import {
  calculateSchemaHash,
  calculateTypePolicyHash,
  checkSchemaDrift,
  generateSchemaPackage,
  loadGeneratedSchemaSnapshot,
  parseSchemaSnapshot,
} from "@typed-sql/schema";

interface ParsedArguments {
  readonly command?: string;
  readonly options: Readonly<Record<string, string>>;
}

const commands = new Set([
  "capabilities",
  "check",
  "compat",
  "doctor",
  "explain",
  "generate",
  "drift",
  "manifest",
  "verify",
]);

async function packageVersion(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  const root = parse(directory).root;
  while (directory !== root) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        readonly name?: string;
        readonly version?: string;
      };
      if (manifest.name === "@typed-sql/cli" && manifest.version !== undefined) return manifest.version;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    directory = dirname(directory);
  }
  throw new Error("Could not determine the @typed-sql/cli version");
}

function help(version: string): string {
  return `typed-sql ${version}

Usage:
  typed-sql <command> [options]

Commands:
  capabilities  Report versioned grammar support from the generated snapshot
  check      Infer SQL result types and verify them with TypeScript 7
  compat     Analyze rolling-deployment compatibility from two snapshots and manifests
  doctor     Report runtime, compiler, grammar, schema, server, and editor compatibility
  explain    Capture and review structured database query plans
  generate   Introspect or load a schema snapshot and generate the typed contract
  drift      Compare the generated contract with the live database catalog
  manifest   Emit a deterministic manifest for every project query
  verify     Verify a manifest from cached proof or native live metadata

Global options:
  -h, --help       Show this help
  -v, --version    Show the installed CLI version

Examples:
  typed-sql capabilities --config typed-sql.config.ts
  typed-sql check --config typed-sql.config.ts --file src/query.ts --project tsconfig.json
  typed-sql compat --before schema.before.json --after schema.after.json --before-manifest old.json --after-manifest new.json
  typed-sql doctor --config typed-sql.config.ts --json
  typed-sql explain --manifest .typed-sql/queries.json --out .typed-sql/plans.json
  typed-sql explain --compare .typed-sql/plans.json
  typed-sql generate --config typed-sql.config.ts --out generated/db
  typed-sql drift --config typed-sql.config.ts
  typed-sql manifest --config typed-sql.config.ts --project tsconfig.json --out .typed-sql/queries.json
  typed-sql verify --config typed-sql.config.ts --live --manifest .typed-sql/queries.json
`;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0];
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}`);
    if (argument === "--live" || argument === "--json") {
      options[argument.slice(2)] = "true";
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals !== -1) options[argument.slice(2, equals)] = argument.slice(equals + 1);
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
    }
  }
  return { ...(command === undefined ? {} : { command }), options };
}

function required(options: Readonly<Record<string, string>>, name: string): string {
  const value = options[name];
  if (value === undefined) throw new Error(`Missing required --${name}`);
  return value;
}

async function readSnapshot(path: string, validate: (value: unknown) => SchemaSnapshot): Promise<SchemaSnapshot> {
  return validate(JSON.parse(await readFile(path, "utf8")) as unknown);
}

interface PackageMetadata {
  readonly version?: string;
  readonly typedSql?: Readonly<Record<string, unknown>>;
}

async function packageMetadata(directory: string, name: string): Promise<PackageMetadata | undefined> {
  const require = createRequire(join(directory, "package.json"));
  let file: string;
  try {
    file = require.resolve(`${name}/package.json`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) {
      if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") return undefined;
      throw error;
    }
    let entry: string;
    try {
      entry = require.resolve(name);
    } catch (entryError) {
      if (entryError instanceof Error && "code" in entryError && entryError.code === "MODULE_NOT_FOUND") {
        return undefined;
      }
      throw entryError;
    }
    let current = dirname(entry);
    const root = parse(current).root;
    while (true) {
      const candidate = join(current, "package.json");
      try {
        const manifest = JSON.parse(await readFile(candidate, "utf8")) as { readonly name?: unknown };
        if (manifest.name === name) {
          file = candidate;
          break;
        }
      } catch (readError) {
        if (!(readError instanceof Error && "code" in readError && readError.code === "ENOENT")) throw readError;
      }
      if (current === root) return undefined;
      current = dirname(current);
    }
  }
  const value = JSON.parse(await readFile(file, "utf8")) as {
    readonly version?: unknown;
    readonly typedSql?: unknown;
  };
  return {
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.typedSql === "object" && value.typedSql !== null
      ? { typedSql: value.typedSql as Readonly<Record<string, unknown>> }
      : {}),
  };
}

function nodeVersionSupport(value: string): "supported" | "unsupported" | "unknown" {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) return "unknown";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 11) ? "supported" : "unsupported";
}

const fingerprint = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function readPreviousManifest(path: string) {
  try {
    return parseQueryManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function projectSources(
  directory: string,
  configured: readonly string[] | undefined,
  projectOption: string | undefined,
) {
  const projects =
    projectOption === undefined
      ? (configured ?? ["tsconfig.json"]).map((project) => fromConfig(directory, project))
      : [resolve(projectOption)];
  if (projects.length === 0) throw new Error("typed-sql requires at least one TypeScript project");
  const sourceFiles = [
    ...new Set(
      (await Promise.all(projects.map((project) => listProjectSourceFiles({ project, cwd: directory })))).flat(),
    ),
  ].sort();
  const sources = await Promise.all(sourceFiles.map(async (file) => ({ file, source: await readFile(file, "utf8") })));
  return { projects, sources };
}

function reportVerification(
  entries: readonly {
    readonly status: string;
    readonly source: { readonly file: string; readonly range: { readonly line: number; readonly column: number } };
    readonly code?: string;
    readonly mismatches?: readonly {
      readonly kind: string;
      readonly target: string;
      readonly index?: number;
      readonly expected: string;
      readonly actual: string;
    }[];
  }[],
): void {
  for (const entry of entries) {
    if (entry.status === "verified") continue;
    process.stderr.write(
      `${entry.source.file}:${entry.source.range.line}:${entry.source.range.column} - ${entry.code ?? "TSQ502"}: ${entry.status}\n`,
    );
    for (const mismatch of entry.mismatches ?? []) {
      const position = mismatch.index === undefined ? mismatch.target : `${mismatch.target} ${mismatch.index}`;
      process.stderr.write(
        `  ${position} ${mismatch.kind}: compiler=${mismatch.expected}, database=${mismatch.actual}\n`,
      );
    }
  }
}

function reportCompatibility(
  assessments: readonly {
    readonly direction: string;
    readonly classification: string;
    readonly severity: string;
    readonly reason: string;
    readonly queries: readonly {
      readonly source: { readonly file: string; readonly range: { readonly line: number; readonly column: number } };
    }[];
  }[],
): void {
  for (const assessment of assessments) {
    const locations =
      assessment.queries.length === 0
        ? "schema-wide"
        : assessment.queries
            .map((query) => `${query.source.file}:${query.source.range.line}:${query.source.range.column}`)
            .join(", ");
    process.stderr.write(
      `${assessment.severity} ${assessment.direction} ${assessment.classification} (${locations}): ${assessment.reason}\n`,
    );
  }
}

function reportPlans(
  entries: readonly {
    readonly status: string;
    readonly source: { readonly file: string; readonly range: { readonly line: number; readonly column: number } };
    readonly reasons: readonly string[];
    readonly violations: readonly { readonly kind: string; readonly expected: string; readonly actual: string }[];
  }[],
): void {
  for (const entry of entries) {
    if (entry.status === "pass" || entry.status === "unbudgeted") continue;
    process.stderr.write(
      `${entry.source.file}:${entry.source.range.line}:${entry.source.range.column} - plan ${entry.status}${entry.reasons.length === 0 ? "" : ` (${entry.reasons.join(", ")})`}\n`,
    );
    for (const violation of entry.violations) {
      process.stderr.write(`  ${violation.kind}: expected ${violation.expected}, actual ${violation.actual}\n`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = await packageVersion();
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help(version));
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const parsed = parseArguments(args);
  if (parsed.command === undefined || !commands.has(parsed.command)) {
    throw new Error(`Unknown command ${parsed.command ?? "<none>"}. Run typed-sql --help for usage.`);
  }
  const loaded = await loadConfig({ ...(parsed.options.config === undefined ? {} : { file: parsed.options.config }) });
  const config = loaded.config;
  const dialect = config.dialect;
  const policy = config.typePolicy ?? dialect.defaultTypePolicy;
  const schemaFile = fromConfig(loaded.directory, parsed.options.schema ?? config.schema.file);

  if (parsed.command === "doctor") {
    if (parsed.options.json !== undefined && parsed.options.json !== "true") {
      throw new Error("--json does not accept a value");
    }
    const requestedProtocol = parsed.options.protocol === undefined ? undefined : Number(parsed.options.protocol);
    if (requestedProtocol !== undefined && (!Number.isSafeInteger(requestedProtocol) || requestedProtocol < 1)) {
      throw new Error("--protocol must be a positive integer");
    }
    const schema = await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value));
    const states = resolveDialectCapabilityStates(dialect, schema, policy);
    const [typescript, languageServer, bridge] = await Promise.all([
      packageMetadata(loaded.directory, "typescript"),
      packageMetadata(loaded.directory, "@typed-sql/language-server"),
      packageMetadata(loaded.directory, "@typed-sql/ts-bridge"),
    ]);
    const typescriptVersion = typescript?.version;
    const typescriptSupport =
      typescriptVersion === undefined ? "unknown" : typeScriptCompilerVersionSupport(typescriptVersion);
    const acceptedProtocols = Array.isArray(languageServer?.typedSql?.acceptedProtocolVersions)
      ? languageServer.typedSql.acceptedProtocolVersions.filter(
          (value): value is number => Number.isSafeInteger(value) && (value as number) > 0,
        )
      : [];
    const legacyProtocol = languageServer?.typedSql?.legacyUnversionedProtocolVersion;
    const clientProtocol =
      requestedProtocol ??
      (typeof legacyProtocol === "number" && Number.isSafeInteger(legacyProtocol) ? legacyProtocol : undefined);
    const protocolCompatibility =
      languageServer === undefined
        ? "not-installed"
        : clientProtocol !== undefined && acceptedProtocols.includes(clientProtocol)
          ? "compatible"
          : "unsupported";
    const errors: string[] = [];
    const warnings: string[] = [];
    const nodeSupport = nodeVersionSupport(process.version);
    if (nodeSupport !== "supported") errors.push(`Node.js ${process.version} is outside the supported runtime range.`);
    if (typescriptSupport !== "supported") {
      errors.push(
        `TypeScript ${typescriptVersion ?? "not installed"} does not match ${TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion}.`,
      );
    }
    if (languageServer === undefined)
      warnings.push("@typed-sql/language-server is not installed; editor analysis is optional.");
    else {
      if (bridge === undefined) errors.push("@typed-sql/language-server is installed without @typed-sql/ts-bridge.");
      if (protocolCompatibility !== "compatible") {
        errors.push(`Editor protocol ${clientProtocol ?? "unversioned"} is outside the installed server window.`);
      }
      const serverPreview = languageServer.typedSql?.typescriptPreviewVersion;
      const bridgePreview = bridge?.typedSql?.typescriptPreviewVersion;
      if (typeof serverPreview !== "string" || typeof bridgePreview !== "string" || serverPreview !== bridgePreview) {
        errors.push("Language-server and bridge TypeScript preview metadata do not match.");
      }
    }
    const capabilityLevels = { exact: 0, conservative: 0, unsupported: 0 };
    for (const state of Object.values(states)) capabilityLevels[state.level] += 1;
    const report = {
      formatVersion: 1,
      status: errors.length === 0 ? "ok" : "error",
      runtime: { node: { version: process.version, support: nodeSupport } },
      typescript: {
        version: typescriptVersion ?? null,
        expected: TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion,
        support: typescriptSupport,
      },
      grammar: {
        id: dialect.id,
        version: dialect.grammarVersion,
        capabilityFingerprint: fingerprint(states),
        capabilityLevels,
      },
      schema: {
        formatVersion: schema.formatVersion,
        dialect: schema.dialect,
        dialectVersion: schema.dialectVersion ?? null,
        hash: calculateSchemaHash(schema),
        typePolicyHash: calculateTypePolicyHash(policy),
      },
      server:
        schema.server === undefined
          ? null
          : {
              product: schema.server.product,
              version: schema.server.version,
              versionKey: schema.server.versionKey,
              featureCount: schema.server.features.length,
              settingKeys: Object.keys(schema.server.settings).sort(),
            },
      editor: {
        languageServer: {
          installed: languageServer !== undefined,
          version: languageServer?.version ?? null,
          releaseTrack: languageServer?.typedSql?.releaseTrack ?? null,
        },
        bridge: {
          installed: bridge !== undefined,
          version: bridge?.version ?? null,
          backend: bridge?.typedSql?.typescriptBackend ?? null,
          typescriptPreviewVersion: bridge?.typedSql?.typescriptPreviewVersion ?? null,
        },
        protocol: {
          client: requestedProtocol === undefined ? "legacy-unversioned" : requestedProtocol,
          normalizedClientVersion: clientProtocol ?? null,
          acceptedVersions: acceptedProtocols,
          compatibility: protocolCompatibility,
        },
      },
      errors,
      warnings,
    } as const;
    if (parsed.options.json === "true") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(
        [
          `typed-sql doctor: ${report.status}`,
          `Node.js: ${report.runtime.node.version} (${report.runtime.node.support})`,
          `TypeScript: ${report.typescript.version ?? "not installed"} (${report.typescript.support}; expected ${report.typescript.expected})`,
          `Grammar: ${report.grammar.id} ${report.grammar.version}`,
          `Schema: format ${report.schema.formatVersion} ${report.schema.hash}`,
          `Server: ${report.server === null ? "no evidence" : `${report.server.product} ${report.server.version}`}`,
          `Language server: ${report.editor.languageServer.installed ? `${report.editor.languageServer.version} (${report.editor.protocol.compatibility})` : "not installed (optional)"}`,
          ...errors.map((message) => `error: ${message}`),
          ...warnings.map((message) => `warning: ${message}`),
          "",
        ].join("\n"),
      );
    }
    if (errors.length > 0) process.exitCode = 1;
    return;
  }

  if (parsed.command === "capabilities") {
    const schema = await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value));
    const states = resolveDialectCapabilityStates(dialect, schema, policy);
    process.stdout.write(
      [
        `Capabilities for ${dialect.id} grammar ${dialect.grammarVersion}`,
        ...Object.entries(states).flatMap(([capability, state]) => [
          `${capability}: ${state.level}${state.diagnostic === undefined ? "" : ` (${state.diagnostic})`}`,
          `  ${state.reason}`,
          ...state.evidence.map(({ kind, key, value }) => `  ${kind}: ${key}=${value}`),
        ]),
        "",
      ].join("\n"),
    );
    return;
  }

  if (parsed.command === "compat") {
    const beforeFile = fromConfig(loaded.directory, required(parsed.options, "before"));
    const afterFile = fromConfig(loaded.directory, required(parsed.options, "after"));
    const beforeManifestFile = fromConfig(loaded.directory, required(parsed.options, "before-manifest"));
    const afterManifestFile = fromConfig(loaded.directory, required(parsed.options, "after-manifest"));
    const outFile = fromConfig(
      loaded.directory,
      parsed.options.out ?? config.compatibility?.reportFile ?? ".typed-sql/compatibility.json",
    );
    const failOn = parsed.options["fail-on"] ?? config.compatibility?.failOn ?? "error";
    if (!(failOn === "none" || failOn === "warning" || failOn === "error")) {
      throw new Error("--fail-on must be none, warning, or error");
    }
    const [before, after, beforeManifest, afterManifest] = await Promise.all([
      readSnapshot(beforeFile, parseSchemaSnapshot),
      readSnapshot(afterFile, parseSchemaSnapshot),
      readFile(beforeManifestFile, "utf8").then((source) => parseQueryManifest(JSON.parse(source) as unknown)),
      readFile(afterManifestFile, "utf8").then((source) => parseQueryManifest(JSON.parse(source) as unknown)),
    ]);
    if (before.dialect !== dialect.id || after.dialect !== dialect.id) {
      throw new TypeError(`Compatibility snapshots must use configured dialect ${dialect.id}`);
    }
    const report = analyzeSchemaCompatibility({ before, after, beforeManifest, afterManifest });
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, serializeSchemaCompatibilityReport(report), "utf8");
    reportCompatibility(report.assessments);
    process.stdout.write(
      `Compatibility: ${report.summary.error} errors, ${report.summary.warning} warnings, ${report.summary.info} informational assessments at ${outFile}\n`,
    );
    if (
      (failOn === "error" && report.summary.error > 0) ||
      (failOn === "warning" && (report.summary.error > 0 || report.summary.warning > 0))
    ) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command === "check") {
    const file = resolve(required(parsed.options, "file"));
    const result = await checkFile({
      file,
      schema: schemaFile,
      dialect,
      typePolicy: policy,
      ...(config.compiler?.maxStructuralVariants === undefined
        ? {}
        : { maxStructuralVariants: config.compiler.maxStructuralVariants }),
      ...(parsed.options.project === undefined ? {} : { project: resolve(parsed.options.project) }),
    });
    for (const diagnostic of result.sqlDiagnostics) {
      const suggestion = diagnostic.suggestion === undefined ? "" : ` ${diagnostic.suggestion}`;
      process.stderr.write(
        `${file}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${suggestion}\n`,
      );
    }
    if (result.typeScript?.output) process.stderr.write(result.typeScript.output);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (parsed.command === "generate") {
    const current =
      parsed.options.snapshot !== undefined
        ? await readSnapshot(resolve(parsed.options.snapshot), (value) => dialect.validateSnapshot(value))
        : config.schema.provider === undefined
          ? await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value))
          : await config.schema.provider.introspect();
    const metadata = await generateSchemaPackage(current as never, {
      outDir: fromConfig(loaded.directory, parsed.options.out ?? config.outDir),
      typePolicy: policy,
      dialectVersion: dialect.grammarVersion,
    });
    process.stdout.write(`Generated schema ${metadata.schemaHash}\n`);
    return;
  }

  if (parsed.command === "manifest") {
    const schema = await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value));
    const { projects, sources } = await projectSources(loaded.directory, config.projects, parsed.options.project);
    const outFile = fromConfig(
      loaded.directory,
      parsed.options.out ?? config.manifest?.outFile ?? ".typed-sql/queries.json",
    );
    const previous = await readPreviousManifest(outFile);
    const result = buildQueryManifest({
      rootDir: loaded.directory,
      sources,
      projects,
      dialect,
      schema,
      typePolicy: policy,
      compilerVersion: version,
      ...(previous === undefined ? {} : { previous }),
      ...(config.compiler?.maxStructuralVariants === undefined
        ? {}
        : { maxStructuralVariants: config.compiler.maxStructuralVariants }),
    });
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, serializeQueryManifest(result.manifest), "utf8");
    process.stdout.write(
      `Generated ${result.manifest.queries.length} queries (${result.stats.unresolvedQueries} unresolved, ${result.stats.reusedFiles} files reused) at ${outFile}\n`,
    );
    if (result.stats.unresolvedQueries > 0) process.exitCode = 2;
    return;
  }

  if (parsed.command === "verify") {
    if (parsed.options.live !== undefined && parsed.options.live !== "true") {
      throw new Error("--live does not accept a value");
    }
    const manifestFile = fromConfig(
      loaded.directory,
      parsed.options.manifest ?? config.manifest?.outFile ?? ".typed-sql/queries.json",
    );
    const proofFile = fromConfig(
      loaded.directory,
      parsed.options.proof ?? config.verification?.proofFile ?? ".typed-sql/verification.json",
    );
    const manifest = parseQueryManifest(JSON.parse(await readFile(manifestFile, "utf8")) as unknown);
    if (parsed.options.live === "true") {
      const verifier = config.verification?.live;
      if (verifier === undefined)
        throw new Error("typed-sql verify --live requires verification.live in typed-sql.config.ts");
      const schema = await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value));
      const { projects, sources } = await projectSources(loaded.directory, config.projects, parsed.options.project);
      const candidates = collectQueryVerificationCandidates({
        manifest,
        rootDir: loaded.directory,
        sources,
        projects,
        dialect,
        schema,
        typePolicy: policy,
        ...(config.compiler?.maxStructuralVariants === undefined
          ? {}
          : { maxStructuralVariants: config.compiler.maxStructuralVariants }),
      });
      try {
        const result = await verifyQueryManifest({
          manifest,
          candidates,
          verifier,
          ...(config.verification?.concurrency === undefined ? {} : { concurrency: config.verification.concurrency }),
        });
        await mkdir(dirname(proofFile), { recursive: true });
        await writeFile(proofFile, serializeQueryVerificationProof(result.proof), "utf8");
        reportVerification(result.proof.entries);
        process.stdout.write(
          `Verified ${result.verified} variants (${result.mismatched} mismatched, ${result.skipped} skipped, ${result.failed} failed) at ${proofFile}\n`,
        );
        if (result.mismatched > 0 || result.failed > 0) process.exitCode = 1;
        else if (result.skipped > 0) process.exitCode = 2;
      } finally {
        await verifier.close();
      }
    } else {
      const proof = parseQueryVerificationProof(JSON.parse(await readFile(proofFile, "utf8")) as unknown);
      assertQueryVerificationProofCurrent(manifest, proof, config.verification?.live);
      reportVerification(proof.entries);
      const mismatched = proof.entries.filter((entry) => entry.status === "mismatch").length;
      const skipped = proof.entries.filter((entry) => entry.status === "skipped").length;
      const failed = proof.entries.filter((entry) => entry.status === "error").length;
      process.stdout.write(`Cached verification is current (${proof.entries.length} entries)\n`);
      if (mismatched > 0 || failed > 0) process.exitCode = 1;
      else if (skipped > 0) process.exitCode = 2;
    }
    return;
  }

  if (parsed.command === "explain") {
    const inspector = config.plans?.live;
    if (inspector === undefined) {
      throw new Error("typed-sql explain requires plans.live in typed-sql.config.ts");
    }
    const failOn = parsed.options["fail-on"] ?? config.plans?.failOn ?? "violation";
    if (!(failOn === "none" || failOn === "violation" || failOn === "uncertainty")) {
      throw new Error("--fail-on must be none, violation, or uncertainty");
    }
    const manifestFile = fromConfig(
      loaded.directory,
      parsed.options.manifest ?? config.manifest?.outFile ?? ".typed-sql/queries.json",
    );
    const artifactFile = fromConfig(
      loaded.directory,
      parsed.options.out ?? config.plans?.artifactFile ?? ".typed-sql/plans.json",
    );
    const reportFile = fromConfig(
      loaded.directory,
      parsed.options.report ?? config.plans?.reportFile ?? ".typed-sql/plan-review.json",
    );
    const compareOption = parsed.options.compare ?? config.plans?.baselineFile;
    const baseline =
      compareOption === undefined
        ? undefined
        : parseQueryPlanArtifact(
            JSON.parse(await readFile(fromConfig(loaded.directory, compareOption), "utf8")) as unknown,
          );
    const manifest = parseQueryManifest(JSON.parse(await readFile(manifestFile, "utf8")) as unknown);
    const schema = await readSnapshot(schemaFile, (value) => dialect.validateSnapshot(value));
    const { projects, sources } = await projectSources(loaded.directory, config.projects, parsed.options.project);
    const candidates = collectQueryVerificationCandidates({
      manifest,
      rootDir: loaded.directory,
      sources,
      projects,
      dialect,
      schema,
      typePolicy: policy,
      ...(config.compiler?.maxStructuralVariants === undefined
        ? {}
        : { maxStructuralVariants: config.compiler.maxStructuralVariants }),
    });
    try {
      const result = await captureQueryPlans({
        manifest,
        candidates,
        inspector,
        ...(config.plans?.sampleValues === undefined ? {} : { sampleValues: config.plans.sampleValues }),
        ...(config.plans?.concurrency === undefined ? {} : { concurrency: config.plans.concurrency }),
      });
      const report = reviewQueryPlans({
        current: result.artifact,
        ...(baseline === undefined ? {} : { baseline }),
        ...(config.plans?.budgets === undefined ? {} : { budgets: config.plans.budgets }),
      });
      await Promise.all([
        mkdir(dirname(artifactFile), { recursive: true }).then(() =>
          writeFile(artifactFile, serializeQueryPlanArtifact(result.artifact), "utf8"),
        ),
        mkdir(dirname(reportFile), { recursive: true }).then(() =>
          writeFile(reportFile, serializeQueryPlanReviewReport(report), "utf8"),
        ),
      ]);
      reportPlans(report.entries);
      process.stdout.write(
        `Captured ${result.captured} plans (${result.skipped} skipped, ${result.failed} failed); review: ${report.summary.violation} violations, ${report.summary.incomparable} incomparable, ${report.summary.unavailable} unavailable at ${reportFile}\n`,
      );
      const uncertainty = report.summary.incomparable + report.summary.unavailable;
      if (failOn === "violation" && report.summary.violation > 0) process.exitCode = 1;
      else if (failOn === "uncertainty" && (report.summary.violation > 0 || uncertainty > 0)) process.exitCode = 1;
    } finally {
      await inspector.close();
    }
    return;
  }

  if (parsed.command === "drift") {
    if (config.schema.provider === undefined)
      throw new Error("typed-sql drift requires schema.provider in typed-sql.config.ts");
    const generated = await loadGeneratedSchemaSnapshot(schemaFile);
    const current = await config.schema.provider.introspect();
    const drift = checkSchemaDrift(generated, current as never, policy);
    if (drift.drifted) {
      const changes = drift.changes.map(({ kind, key }) => `${kind}:${key}`).join(",");
      process.stderr.write(
        `error TSQ301: Schema drift detected (schemaChanged=${drift.schemaChanged}, typePolicyChanged=${drift.typePolicyChanged}, changes=${changes})\n`,
      );
      process.exitCode = 1;
    } else process.stdout.write("No schema drift detected\n");
    return;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
