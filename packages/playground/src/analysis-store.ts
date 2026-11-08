import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  type AnalysisArtifact,
  type AnalysisCapture,
  type AnalysisDataset,
  type FilterValues,
  presentationSchema,
} from "./analysis-contract.js";
import { cellText } from "./analysis-model.js";
import { contentHash, WorkspaceError } from "./files.js";
import { privateRead, privateWrite } from "./private-storage.js";
import { timelineOrder } from "./timeline.js";
import { decodeValue, encodeValue, type WireValue } from "./values.js";

const identifier = z.string().uuid();
const wire = z.custom<WireValue>((value) => {
  try {
    decodeValue(value as WireValue);
    return true;
  } catch {
    return false;
  }
}, "Invalid lossless value");
const identitySchema = z.object({ database: z.string().min(1).max(4096), server: z.string().min(1).max(4096) });
const datasetSchema = z.object({
  id: identifier,
  conversationId: identifier,
  capturedAt: z.iso.datetime(),
  schemaHash: z.string().min(1).max(200),
  typePolicyHash: z.string().max(200).optional(),
  parameterTypes: z.array(z.string().max(1000)).max(50).optional(),
  target: z.string().min(1).max(200),
  source: z.string().min(1).max(32768),
  values: z.array(wire).max(50),
  columns: z.array(z.string().max(512)).max(256),
  rows: z.array(z.array(wire).max(256)).max(1000),
  complete: z.boolean(),
  identity: identitySchema,
});
const artifactSchema = z.object({
  id: identifier,
  conversationId: identifier,
  createdAt: z.iso.datetime(),
  revision: identifier,
  initialDatasetId: identifier,
  order: z.number().int().optional(),
  spec: presentationSchema,
  filters: z.unknown(),
});
function bad(message: string): never {
  throw new WorkspaceError("ANALYSIS", message, 400);
}
export class AnalysisStore {
  private readonly path: string;
  private readonly datasets = new Map<string, AnalysisDataset>();
  private readonly artifacts = new Map<string, AnalysisArtifact>();
  private readonly ready: Promise<void>;
  private persistence = Promise.resolve();
  constructor(root: string, directory: string) {
    this.path = join(directory, "analyses", `${createHash("sha256").update(root).digest("hex")}.json`);
    this.ready = this.load();
    void this.ready.catch(() => undefined);
  }
  private async load() {
    try {
      const state = z
        .object({
          version: z.literal(1),
          datasets: z.array(datasetSchema).max(100),
          artifacts: z.array(artifactSchema).max(100),
        })
        .parse(JSON.parse(await privateRead(this.path)));
      for (const dataset of state.datasets) {
        if (dataset.rows.some((row) => row.length !== dataset.columns.length) || this.datasets.has(dataset.id))
          bad("Invalid saved dataset");
        this.datasets.set(dataset.id, dataset);
      }
      for (const artifact of state.artifacts) {
        const dataset = this.datasets.get(artifact.spec.datasetId),
          original = this.datasets.get(artifact.initialDatasetId);
        if (
          !dataset ||
          dataset.conversationId !== artifact.conversationId ||
          !original ||
          original.conversationId !== artifact.conversationId ||
          this.artifacts.has(artifact.id)
        )
          bad("Invalid saved analysis source");
        this.validate(artifact.spec, dataset);
        this.artifacts.set(artifact.id, { ...artifact, filters: this.filterValues(artifact.spec, artifact.filters) });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  private persist() {
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(() =>
        privateWrite(this.path, {
          version: 1,
          datasets: [...this.datasets.values()],
          artifacts: [...this.artifacts.values()],
        }),
      );
    return this.persistence;
  }
  async capture(
    conversationId: string,
    source: string,
    values: readonly WireValue[],
    result: Record<string, unknown>,
    target: string,
  ) {
    await this.ready;
    identifier.parse(conversationId);
    if (result.executed !== true) bad("Query did not execute; resolve its diagnostics before presenting data");
    const raw = z
      .object({
        columns: z.array(z.object({ name: z.string().max(512) })).max(256),
        rows: z.array(z.array(z.unknown()).max(256)).max(1000),
        truncated: z.boolean(),
      })
      .parse(decodeValue(result.value as WireValue));
    if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) bad("Query has no tabular result");
    if (raw.columns.length > 256 || raw.rows.length > 1000 || raw.rows.some((row) => row.length !== raw.columns.length))
      bad("Dataset exceeds analysis bounds");
    if (this.datasets.size >= 100)
      bad("Analysis capture limit reached; start a workspace with archived analysis storage");
    const dataset: AnalysisDataset = datasetSchema.parse({
      id: randomUUID(),
      conversationId,
      capturedAt: new Date().toISOString(),
      schemaHash: String(result.schemaHash),
      ...(typeof result.typePolicyHash === "string" ? { typePolicyHash: result.typePolicyHash } : {}),
      ...(Array.isArray(result.parameterTypes) ? { parameterTypes: result.parameterTypes } : {}),
      target,
      source,
      values,
      columns: raw.columns.map((c) => c.name),
      rows: raw.rows.map((row) => row.map((value) => encodeValue(value))),
      complete: !raw.truncated,
      identity: identitySchema.parse(result.identity),
    });
    this.datasets.set(dataset.id, dataset);
    try {
      await this.persist();
    } catch (error) {
      this.datasets.delete(dataset.id);
      throw error;
    }
    return dataset;
  }
  async dataset(id: string, conversationId?: string) {
    await this.ready;
    identifier.parse(id);
    const dataset = this.datasets.get(id);
    if (!dataset || (conversationId !== undefined && dataset.conversationId !== conversationId))
      bad("Dataset is unavailable in this conversation");
    return dataset;
  }
  private validate(spec: AnalysisArtifact["spec"], dataset: AnalysisDataset) {
    const ids = [...spec.views, ...spec.filters].map((x) => x.id);
    if (new Set(ids).size !== ids.length) bad("View and filter IDs must be unique");
    for (const view of spec.views) {
      for (const field of [view.x, view.y, view.compareTo, view.series, ...(view.hierarchy ?? [])])
        if (field !== undefined && field >= dataset.columns.length) bad(`Unknown column ordinal in ${view.title}`);
      if (
        view.linkFilter &&
        !spec.filters.some(
          (filter) => filter.id === view.linkFilter && filter.mode === "captured" && filter.kind === "select",
        )
      )
        bad("Linked selections require a captured select filter");
      if (
        view.kind !== "table" &&
        view.kind !== "histogram" &&
        !(view.kind === "metric" && view.aggregate === "count") &&
        view.y === undefined
      )
        bad(`Choose a measure column for ${view.title}`);
      if (!["metric", "table", "sunburst", "treemap"].includes(view.kind) && view.x === undefined)
        bad(`Choose a dimension column for ${view.title}`);
      if (["sunburst", "treemap"].includes(view.kind) && !view.hierarchy?.length)
        bad("Hierarchical charts require ordered hierarchy columns");
      if (["sankey", "heatmap"].includes(view.kind) && view.series === undefined)
        bad(`${view.kind} requires a second dimension in series`);
    }
    for (const filter of spec.filters) {
      if (filter.column >= dataset.columns.length) bad("Unknown filter column");
      if (filter.mode === "query" && (filter.parameter === undefined || filter.parameter >= dataset.values.length))
        bad("Query filters must bind an existing parameter ordinal");
    }
  }
  filterValues(spec: AnalysisArtifact["spec"], input: unknown): FilterValues {
    const values = z
      .record(z.string(), z.union([z.string().max(1000), z.boolean(), z.array(z.string().max(200)).max(200)]))
      .parse(input);
    for (const [key, value] of Object.entries(values)) {
      const filter = spec.filters.find((f) => f.id === key);
      if (
        !filter ||
        (filter.kind === "multiselect"
          ? !Array.isArray(value)
          : filter.kind === "toggle"
            ? typeof value !== "boolean"
            : typeof value !== "string")
      )
        bad("Filter values do not match the published controls");
      if (
        filter.options &&
        (Array.isArray(value)
          ? value.some((v) => !filter.options!.includes(v))
          : typeof value === "string" && value !== "" && !filter.options.includes(value))
      )
        bad("Choose one of the published filter options");
    }
    return values;
  }
  async publish(conversationId: string, input: unknown) {
    const spec = presentationSchema.parse(input);
    const dataset = await this.dataset(spec.datasetId, conversationId);
    this.validate(spec, dataset);
    for (const filter of spec.filters)
      if (["select", "multiselect"].includes(filter.kind) && filter.options === undefined) {
        const options = [...new Set(dataset.rows.map((row) => cellText(row[filter.column])))];
        if (options.length <= 200) filter.options = options;
      }
    if (this.artifacts.size >= 100) bad("Analysis card limit reached");
    const artifact: AnalysisArtifact = {
      id: randomUUID(),
      conversationId,
      createdAt: new Date().toISOString(),
      revision: randomUUID(),
      initialDatasetId: dataset.id,
      order: timelineOrder(),
      spec,
      filters: {},
    };
    this.artifacts.set(artifact.id, artifact);
    try {
      await this.persist();
    } catch (error) {
      this.artifacts.delete(artifact.id);
      throw error;
    }
    return artifact;
  }
  async list(conversationId?: string) {
    await this.ready;
    return [...this.artifacts.values()]
      .filter((a) => !conversationId || a.conversationId === conversationId)
      .map(({ id, createdAt, spec, conversationId, order }) => ({
        id,
        createdAt,
        title: spec.title,
        conversationId,
        order,
      }));
  }
  async listDatasets(conversationId: string) {
    await this.ready;
    return [...this.datasets.values()]
      .filter((dataset) => dataset.conversationId === conversationId)
      .map((dataset) => ({
        datasetId: dataset.id,
        capturedAt: dataset.capturedAt,
        rows: dataset.rows.length,
        complete: dataset.complete,
        columnCount: dataset.columns.length,
        columns: dataset.columns.slice(0, 8),
      }));
  }
  async get(id: string): Promise<AnalysisCapture> {
    await this.ready;
    identifier.parse(id);
    const artifact = this.artifacts.get(id);
    if (!artifact) bad("Analysis is unavailable");
    return { artifact, dataset: await this.dataset(artifact.spec.datasetId, artifact.conversationId) };
  }
  async update(id: string, revision: string, filters: unknown, dataset?: AnalysisDataset) {
    const current = await this.get(id);
    if (current.artifact.revision !== revision)
      throw new WorkspaceError("ANALYSIS_CONFLICT", "This analysis changed; reload before applying filters", 409);
    if (
      dataset &&
      (dataset.conversationId !== current.artifact.conversationId ||
        dataset.schemaHash !== current.dataset.schemaHash ||
        dataset.typePolicyHash !== current.dataset.typePolicyHash ||
        dataset.target !== current.dataset.target ||
        JSON.stringify(dataset.identity) !== JSON.stringify(current.dataset.identity))
    )
      bad("Target or schema changed; publish a new analysis");
    const next: AnalysisArtifact = {
      ...current.artifact,
      filters: this.filterValues(current.artifact.spec, filters),
      revision: randomUUID(),
      spec: { ...current.artifact.spec, datasetId: dataset?.id ?? current.dataset.id },
    };
    // Recheck after async reads; mutations are synchronous until the persistence reservation.
    if (this.artifacts.get(id)?.revision !== revision)
      throw new WorkspaceError("ANALYSIS_CONFLICT", "Analysis changed while updating", 409);
    this.artifacts.set(id, next);
    const referenced = new Set(
      [...this.artifacts.values()].flatMap((artifact) => [artifact.spec.datasetId, artifact.initialDatasetId]),
    );
    const discard = !referenced.has(current.dataset.id);
    if (discard) this.datasets.delete(current.dataset.id);
    try {
      await this.persist();
    } catch (error) {
      if (this.artifacts.get(id)?.revision === next.revision) this.artifacts.set(id, current.artifact);
      if (discard) this.datasets.set(current.dataset.id, current.dataset);
      throw error;
    }
    return this.get(id);
  }
  async definition(id: string) {
    const { artifact, dataset } = await this.get(id);
    const { datasetId: _dataset, ...spec } = artifact.spec;
    return {
      version: 1,
      spec,
      query: { sql: dataset.source, values: dataset.values },
      filters: artifact.filters,
      sourceSchemaHash: dataset.schemaHash,
      sourceHash: contentHash(dataset.source),
    };
  }
  async remove(id: string, revision: string) {
    const { artifact } = await this.get(id);
    if (artifact.revision !== revision)
      throw new WorkspaceError("ANALYSIS_CONFLICT", "Analysis changed; reload before removing it", 409);
    this.artifacts.delete(id);
    const referenced = new Set(
      [...this.artifacts.values()].flatMap((artifact) => [artifact.spec.datasetId, artifact.initialDatasetId]),
    );
    const removed = [...this.datasets.values()].filter(
      (dataset) =>
        [artifact.spec.datasetId, artifact.initialDatasetId].includes(dataset.id) && !referenced.has(dataset.id),
    );
    for (const dataset of removed) this.datasets.delete(dataset.id);
    try {
      await this.persist();
    } catch (error) {
      this.artifacts.set(id, artifact);
      for (const dataset of removed) this.datasets.set(dataset.id, dataset);
      throw error;
    }
    return { removed: true };
  }
}
