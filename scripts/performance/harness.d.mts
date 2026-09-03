export interface BenchmarkStatistics {
  readonly samples: number;
  readonly minimum: number;
  readonly mean: number;
  readonly standardDeviation: number;
  readonly coefficientOfVariation: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly maximum: number;
}

export interface Measurement extends BenchmarkStatistics {
  readonly iterationsPerSample: number;
  readonly rawSamples: readonly number[];
}

export interface MeasurementOptions {
  readonly operation: (iteration: number) => unknown;
  readonly warmupOperation?: (iteration: number) => unknown;
  readonly warmups: number;
  readonly samples: number;
  readonly iterations?: number;
  readonly clock?: () => number;
}

export interface AsyncMeasurementOptions extends Omit<MeasurementOptions, "operation"> {
  readonly operation: (iteration: number) => unknown | Promise<unknown>;
  readonly warmupOperation?: (iteration: number) => unknown | Promise<unknown>;
}

export interface PerformanceContextOptions {
  readonly budgetVersion: number;
  readonly productionBuild: boolean;
  readonly workspace: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly system?: {
    readonly node: string;
    readonly platform: string;
    readonly platformRelease: string;
    readonly architecture: string;
    readonly processors: readonly { readonly model: string }[];
    readonly totalMemoryBytes: number;
  };
  readonly git?: {
    readonly gitRevision: string;
    readonly gitDirty?: boolean;
  };
}

export interface PerformanceContext {
  readonly node: string;
  readonly platform: string;
  readonly platformRelease: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly totalMemoryMiB: number;
  readonly ci: boolean;
  readonly productionBuild: boolean;
  readonly budgetVersion: number;
  readonly packageManager: string;
  readonly gitRevision: string;
  readonly gitDirty?: boolean;
}

export interface PerformanceArtifact {
  readonly formatVersion: 1;
  readonly generatedAt: string;
  readonly context: PerformanceContext;
  readonly results: Readonly<Record<string, unknown>>;
}

export function percentile(samples: readonly number[], quantile: number): number;
export function statistics(samples: readonly number[]): BenchmarkStatistics;
export function measureLatency(options: AsyncMeasurementOptions): Promise<Measurement>;
export function measureThroughput(options: MeasurementOptions & { readonly iterations: number }): Measurement;
export function capturePerformanceContext(options: PerformanceContextOptions): PerformanceContext;
export function createPerformanceArtifact(
  context: PerformanceContext,
  results: Readonly<Record<string, unknown>>,
  generatedAt?: Date,
): PerformanceArtifact;
export function summarizePerformanceResults(
  results: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;
export function writePerformanceArtifact(path: string, artifact: PerformanceArtifact): Promise<void>;
