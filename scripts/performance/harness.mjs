import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function samplesOf(values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("samples must be a non-empty array");
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError("samples must contain only finite numbers");
  }
  return values;
}

export function percentile(samples, quantile) {
  const values = samplesOf(samples);
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1)
    throw new RangeError("quantile must be between zero and one");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

export function statistics(samples) {
  const values = samplesOf(samples);
  const mean = values.reduce((total, sample) => total + sample, 0) / values.length;
  const variance = values.reduce((total, sample) => total + (sample - mean) ** 2, 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    samples: values.length,
    minimum: Math.min(...values),
    mean,
    standardDeviation,
    coefficientOfVariation: mean === 0 ? 0 : standardDeviation / Math.abs(mean),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
  };
}

export async function measureLatency({
  operation,
  warmupOperation = operation,
  warmups,
  samples,
  iterations = 1,
  clock = performance.now.bind(performance),
}) {
  positiveInteger(warmups, "warmups");
  const sampleCount = positiveInteger(samples, "samples");
  const iterationsPerSample = positiveInteger(iterations, "iterations");
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  if (typeof warmupOperation !== "function") throw new TypeError("warmupOperation must be a function");

  for (let warmup = 0; warmup < warmups; warmup += 1) {
    for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
      await warmupOperation(warmup * iterationsPerSample + iteration);
    }
  }

  const measuredSamples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = clock();
    for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
      await operation(sample * iterationsPerSample + iteration);
    }
    const elapsed = clock() - start;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new RangeError("clock must advance monotonically");
    measuredSamples.push(elapsed / iterationsPerSample);
  }

  return { iterationsPerSample, rawSamples: Object.freeze(measuredSamples), ...statistics(measuredSamples) };
}

export function measureThroughput({
  operation,
  warmupOperation = operation,
  warmups,
  samples,
  iterations,
  clock = performance.now.bind(performance),
}) {
  positiveInteger(warmups, "warmups");
  const sampleCount = positiveInteger(samples, "samples");
  const iterationsPerSample = positiveInteger(iterations, "iterations");
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  if (typeof warmupOperation !== "function") throw new TypeError("warmupOperation must be a function");

  for (let warmup = 0; warmup < warmups; warmup += 1) {
    for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
      warmupOperation(warmup * iterationsPerSample + iteration);
    }
  }

  const measuredSamples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = clock();
    for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
      operation(sample * iterationsPerSample + iteration);
    }
    const elapsed = clock() - start;
    if (!Number.isFinite(elapsed) || elapsed <= 0) throw new RangeError("clock must advance after each sample");
    measuredSamples.push((iterationsPerSample * 1_000) / elapsed);
  }

  return { iterationsPerSample, rawSamples: Object.freeze(measuredSamples), ...statistics(measuredSamples) };
}

function gitContext(workspace) {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--short", "--untracked-files=normal"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { gitRevision: revision || "unknown", gitDirty: status.length > 0 };
  } catch {
    return { gitRevision: "unknown", gitDirty: undefined };
  }
}

export function capturePerformanceContext({
  budgetVersion,
  productionBuild,
  workspace,
  environment = process.env,
  system,
  git,
}) {
  const processors = system?.processors ?? cpus();
  const memoryBytes = system?.totalMemoryBytes ?? totalmem();
  const sourceControl = git ?? gitContext(workspace);
  return {
    node: system?.node ?? process.version,
    platform: system?.platform ?? platform(),
    platformRelease: system?.platformRelease ?? release(),
    architecture: system?.architecture ?? process.arch,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryMiB: Math.round(memoryBytes / 1024 / 1024),
    ci: environment.CI === "true",
    productionBuild,
    budgetVersion,
    packageManager: environment.npm_config_user_agent?.split(" ", 1)[0] ?? "unknown",
    ...sourceControl,
  };
}

export function createPerformanceArtifact(context, results, generatedAt = new Date()) {
  return {
    formatVersion: 1,
    generatedAt: generatedAt.toISOString(),
    context,
    results,
  };
}

export function summarizePerformanceResults(results) {
  return Object.fromEntries(
    Object.entries(results).map(([name, result]) => {
      if (typeof result !== "object" || result === null || !("rawSamples" in result)) return [name, result];
      const { rawSamples: _rawSamples, ...summary } = result;
      return [name, summary];
    }),
  );
}

export async function writePerformanceArtifact(path, artifact) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("artifact path must be a non-empty string");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
