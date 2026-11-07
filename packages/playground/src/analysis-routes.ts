import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { type AnalysisCapture, presentationSchema } from "./analysis-contract.js";
import type { AnalysisStore } from "./analysis-store.js";
import { WorkspaceError, type WorkspaceFiles } from "./files.js";
import { encodeValue, type WireValue } from "./values.js";

const id = z.string().uuid();
const definition = z
  .object({
    version: z.literal(1),
    spec: presentationSchema.omit({ datasetId: true }),
    query: z.object({ sql: z.string().min(1).max(32768), values: z.array(z.unknown()).max(50) }).strict(),
    filters: z.record(z.string(), z.unknown()),
    sourceSchemaHash: z.string(),
    sourceHash: z.string(),
  })
  .strict();
export class AnalysisRoutes {
  constructor(
    private readonly options: {
      store: AnalysisStore;
      files: WorkspaceFiles;
      trusted: () => boolean;
      schemaHash: () => string;
      typePolicyHash?: () => string;
      target: string;
      query: (
        source: string,
        values: readonly WireValue[],
        signal: AbortSignal,
        expectedIdentity?: { database: string; server: string },
      ) => Promise<Record<string, unknown>>;
    },
  ) {}
  async handle(url: URL, method: string, body: unknown) {
    if (!this.options.trusted())
      throw new WorkspaceError("TRUST", "Enable trusted project execution to inspect analysis data", 403);
    const store = this.options.store;
    if (method === "GET" && url.pathname === "/api/analyses")
      return store.list(url.searchParams.get("conversation") ?? undefined);
    if (method === "GET" && url.pathname === "/api/analyses/capture")
      return store.get(id.parse(url.searchParams.get("id")));
    if (method === "GET" && url.pathname === "/api/analyses/definition")
      return store.definition(id.parse(url.searchParams.get("id")));
    if (method !== "POST") throw new WorkspaceError("METHOD", "Method not allowed", 405);
    if (url.pathname === "/api/analyses/remove") {
      const input = z.object({ id, revision: z.string().uuid() }).strict().parse(body);
      return store.remove(input.id, input.revision);
    }
    if (url.pathname === "/api/analyses/save") {
      const input = z
        .object({ id, file: z.string().min(1).max(4096) })
        .strict()
        .parse(body);
      if (!input.file.endsWith(".analysis.json"))
        throw new WorkspaceError("ANALYSIS", "Save with the .analysis.json extension", 400);
      return this.options.files.save(
        input.file,
        `${JSON.stringify(await store.definition(input.id), null, 2)}\n`,
        null,
      );
    }
    if (url.pathname === "/api/analyses/open") {
      const input = z
        .object({ file: z.string().min(1).max(4096) })
        .strict()
        .parse(body);
      if (!input.file.endsWith(".analysis.json"))
        throw new WorkspaceError("ANALYSIS", "Choose an analysis definition", 400);
      const saved = definition.parse(JSON.parse((await this.options.files.read(input.file)).source));
      if (saved.sourceSchemaHash !== this.options.schemaHash())
        throw new WorkspaceError(
          "ANALYSIS_STALE",
          "Schema changed; review and update the analysis definition before refreshing",
          409,
        );
      const result = await this.query(saved.query.sql, saved.query.values as WireValue[]);
      const dataset = await store.capture(
        randomUUID(),
        saved.query.sql,
        saved.query.values as WireValue[],
        result,
        this.options.target,
      );
      const artifact = await store.publish(dataset.conversationId, { ...saved.spec, datasetId: dataset.id });
      return store.update(artifact.id, artifact.revision, saved.filters);
    }
    if (url.pathname === "/api/analyses/filters") {
      const input = z.object({ id, revision: z.string().uuid(), values: z.unknown() }).strict().parse(body);
      const current = await store.get(input.id);
      if (current.artifact.revision !== input.revision)
        throw new WorkspaceError("ANALYSIS_CONFLICT", "This analysis changed; reload before applying filters", 409);
      const values = store.filterValues(current.artifact.spec, input.values);
      const queryFilters = current.artifact.spec.filters.filter((f) => f.mode === "query");
      const changed = queryFilters.some(
        (f) => JSON.stringify(values[f.id]) !== JSON.stringify(current.artifact.filters[f.id]),
      );
      if (!changed) return store.update(input.id, input.revision, values);
      if (
        current.dataset.target !== this.options.target ||
        (this.options.typePolicyHash && current.dataset.typePolicyHash !== this.options.typePolicyHash())
      )
        throw new WorkspaceError(
          "ANALYSIS_STALE",
          "Target or type policy changed; publish a new analysis before rerunning",
          409,
        );
      if (current.dataset.schemaHash !== this.options.schemaHash())
        throw new WorkspaceError("ANALYSIS_STALE", "Schema changed; publish a new analysis before rerunning", 409);
      const original = await store.dataset(current.artifact.initialDatasetId, current.artifact.conversationId);
      const parameters = [...original.values];
      for (const filter of queryFilters) {
        const value = values[filter.id];
        if (value === undefined || value === "") continue;
        const originalValue = original.values[filter.parameter!],
          type = original.parameterTypes?.[filter.parameter!] ?? typeof originalValue;
        if (filter.kind === "number") {
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(String(value)))
            throw new WorkspaceError("ANALYSIS", "Enter a finite numeric filter value", 400);
          parameters[filter.parameter!] =
            type.includes("bigint") || (typeof originalValue === "object" && originalValue?.kind === "bigint")
              ? encodeValue(BigInt(String(value)))
              : encodeValue(
                  type.includes("string") || typeof originalValue === "string" ? String(value) : Number(String(value)),
                );
        } else if (filter.kind === "date" && typeof originalValue === "object" && originalValue?.kind === "date")
          parameters[filter.parameter!] = encodeValue(new Date(String(value)));
        else parameters[filter.parameter!] = encodeValue(value);
      }
      const result = await this.query(current.dataset.source, parameters, current.dataset.identity);
      const dataset = await store.capture(
        current.artifact.conversationId,
        current.dataset.source,
        parameters,
        result,
        this.options.target,
      );
      return store.update(input.id, input.revision, values, dataset);
    }
    throw new WorkspaceError("NOT_FOUND", "Analysis action not found", 404);
  }
  private async query(
    source: string,
    values: readonly WireValue[],
    expectedIdentity?: { database: string; server: string },
  ) {
    const result = await this.options.query(source, values, AbortSignal.timeout(5000), expectedIdentity);
    if (!this.options.trusted()) throw new WorkspaceError("TRUST", "Project trust was revoked", 403);
    return result;
  }
}
export type { AnalysisCapture };
