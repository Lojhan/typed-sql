import { z } from "zod/v4";
import type { WireValue } from "./value-types.js";

const text = z.string().min(1).max(200);
const column = z.number().int().min(0).max(255);
export const viewSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    title: text,
    kind: z.enum([
      "metric",
      "table",
      "bar",
      "stacked-bar",
      "line",
      "area",
      "scatter",
      "histogram",
      "donut",
      "pie",
      "sunburst",
      "treemap",
      "heatmap",
      "funnel",
      "sankey",
    ]),
    x: column.optional(),
    y: column.optional(),
    compareTo: column.optional(),
    compareLabel: text.optional(),
    linkFilter: z.string().max(64).optional(),
    series: column.optional(),
    hierarchy: z.array(column).min(1).max(6).optional(),
    aggregate: z.enum(["first", "sum", "count"]).default("sum"),
    unit: z.string().max(40).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();
export const filterSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    label: text,
    kind: z.enum(["select", "multiselect", "text", "number", "date", "toggle"]),
    column: column,
    mode: z.enum(["captured", "query"]).default("captured"),
    parameter: z.number().int().min(0).max(49).optional(),
    operator: z.enum(["equals", "contains", "gte", "lte"]).default("equals"),
    options: z.array(z.string().max(200)).max(200).optional(),
  })
  .strict();
export const presentationSchema = z
  .object({
    version: z.literal(1),
    title: text,
    description: z.string().max(5000).optional(),
    datasetId: z.string().uuid(),
    views: z.array(viewSchema).min(1).max(12),
    filters: z.array(filterSchema).max(12).default([]),
    layout: z.enum(["stack", "grid"]).default("stack"),
  })
  .strict();
export type AnalysisView = z.infer<typeof viewSchema>;
export type AnalysisFilter = z.infer<typeof filterSchema>;
export type Presentation = z.infer<typeof presentationSchema>;
export type FilterValues = Record<string, string | string[] | boolean>;
export interface AnalysisDataset {
  id: string;
  conversationId: string;
  capturedAt: string;
  schemaHash: string;
  typePolicyHash?: string | undefined;
  parameterTypes?: string[] | undefined;
  target: string;
  source: string;
  values: readonly WireValue[];
  columns: string[];
  rows: WireValue[][];
  complete: boolean;
  identity: { database: string; server: string };
}
export interface AnalysisArtifact {
  id: string;
  conversationId: string;
  createdAt: string;
  revision: string;
  initialDatasetId: string;
  order?: number | undefined;
  spec: Presentation;
  filters: FilterValues;
}
export interface AnalysisCapture {
  artifact: AnalysisArtifact;
  dataset: AnalysisDataset;
}
