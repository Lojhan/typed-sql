import type { SchemaSnapshot } from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash, parseSchemaSnapshot } from "@typed-sql/schema";
import { canonicalContractData, queryContractDigest } from "./canonical.js";
import { parseQueryContractContext, type QueryContractContext } from "./contracts.js";

export type ProjectCatalogPermission = "declaration-only" | "fixed-result" | "qualified-rule" | "query-only";
export interface ProjectCatalogEntry {
  readonly kind: string;
  readonly identity: string;
  readonly permission: ProjectCatalogPermission;
  readonly evidenceDigest: string;
  /** Grammar-owned metadata, never executable generated source. */
  readonly definition: Readonly<Record<string, unknown>>;
}
export interface ProjectCatalog {
  readonly formatVersion: 1;
  readonly digest: string;
  readonly context: QueryContractContext;
  readonly owner: { readonly id: string; readonly version: string };
  readonly entries: readonly ProjectCatalogEntry[];
}
export interface ProjectCatalogContribution<Snapshot extends SchemaSnapshot, Policy> {
  readonly id: string;
  readonly version: string;
  readonly grammar: QueryContractContext["grammar"];
  /** Revalidates permissions and interprets metadata using grammar-owned rules and codecs. */
  apply(schema: Snapshot, entries: readonly ProjectCatalogEntry[], policy: Policy): Snapshot;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid project catalog object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(","))
    throw new TypeError("Invalid project catalog fields");
}
function text(value: unknown): void {
  if (typeof value !== "string" || !value.length || value.length > 4096)
    throw new TypeError("Invalid project catalog identity");
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Validates bounded data and provenance identity; it does not grant inference permission. */
export function parseProjectCatalog(input: unknown): ProjectCatalog {
  const value = record(JSON.parse(canonicalContractData(input)));
  fields(value, ["formatVersion", "digest", "context", "owner", "entries"]);
  const { digest, ...body } = value;
  if (value.formatVersion !== 1 || digest !== queryContractDigest(body))
    throw new TypeError("Project catalog digest or format differs");
  parseQueryContractContext(value.context);
  const owner = record(value.owner);
  fields(owner, ["id", "version"]);
  text(owner.id);
  text(owner.version);
  if (!Array.isArray(value.entries) || value.entries.length > 4096)
    throw new RangeError("Project catalog entry limit exceeded");
  let previous = "";
  for (const source of value.entries) {
    const entry = record(source);
    fields(entry, ["kind", "identity", "permission", "evidenceDigest", "definition"]);
    text(entry.kind);
    text(entry.identity);
    if (
      !["declaration-only", "fixed-result", "qualified-rule", "query-only"].includes(entry.permission as string) ||
      typeof entry.evidenceDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.evidenceDigest)
    )
      throw new TypeError("Invalid project catalog permission or evidence identity");
    record(entry.definition);
    const key = canonicalContractData([entry.kind, entry.identity]);
    if (key <= previous) throw new TypeError("Project catalog entries must have sorted unique identities");
    previous = key;
  }
  return freeze(value) as unknown as ProjectCatalog;
}
export function createProjectCatalog(input: Omit<ProjectCatalog, "formatVersion" | "digest">): ProjectCatalog {
  const entries = [...input.entries].sort((left, right) => {
    const a = canonicalContractData([left.kind, left.identity]),
      b = canonicalContractData([right.kind, right.identity]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const body = { formatVersion: 1, context: input.context, owner: input.owner, entries };
  return parseProjectCatalog({ ...body, digest: queryContractDigest(body) });
}
/** Explicit offline interpretation. Returned context identities must accompany the enriched schema. */
export function applyProjectCatalogs<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly schema: Snapshot;
  readonly context: QueryContractContext;
  readonly typePolicy: Policy;
  readonly catalogs: readonly ProjectCatalog[];
  readonly contributions: readonly ProjectCatalogContribution<Snapshot, Policy>[];
}): { readonly schema: Snapshot; readonly context: QueryContractContext } {
  const context = parseQueryContractContext(input.context);
  if (
    input.schema.dialect !== context.grammar.id ||
    (input.schema.dialectVersion !== undefined && input.schema.dialectVersion !== context.grammar.version) ||
    calculateSchemaHash(input.schema) !== context.schemaHash ||
    calculateTypePolicyHash(input.typePolicy ?? {}) !== context.typePolicyHash
  )
    throw new TypeError("Project catalog base schema, grammar or decoding policy differs");
  if (input.catalogs.length > 64 || input.contributions.length > 64)
    throw new RangeError("Project catalog owner limit exceeded");
  const owners = new Map<string, ProjectCatalogContribution<Snapshot, Policy>>();
  for (const owner of input.contributions) {
    text(owner.id);
    text(owner.version);
    if (
      canonicalContractData(owner.grammar) !== canonicalContractData(context.grammar) ||
      typeof owner.apply !== "function" ||
      owners.has(owner.id)
    )
      throw new TypeError("Conflicting project catalog owner or grammar");
    owners.set(owner.id, owner);
  }
  const catalogs = input.catalogs
    .map(parseProjectCatalog)
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const identities = new Set<string>();
  for (const catalog of catalogs) {
    if (canonicalContractData(catalog.context) !== canonicalContractData(context))
      throw new TypeError("Project catalog recorded context differs");
    const owner = owners.get(catalog.owner.id);
    if (!owner || owner.version !== catalog.owner.version)
      throw new TypeError("Project catalog interpreter is unavailable");
    for (const entry of catalog.entries) {
      const key = canonicalContractData([entry.kind, entry.identity]);
      if (identities.has(key)) throw new TypeError("Conflicting project catalog declaration ownership");
      identities.add(key);
    }
  }
  let schema = freeze(parseSchemaSnapshot(JSON.parse(canonicalContractData(input.schema)))) as Snapshot;
  for (const catalog of catalogs) {
    const projected = owners.get(catalog.owner.id)!.apply(schema, catalog.entries, input.typePolicy);
    const { metadata: _metadata, ...body } = JSON.parse(canonicalContractData(projected));
    schema = freeze(parseSchemaSnapshot(body)) as Snapshot;
    if (
      schema.dialect !== context.grammar.id ||
      (schema.dialectVersion !== undefined && schema.dialectVersion !== context.grammar.version)
    )
      throw new TypeError("Project catalog interpreter changed grammar");
  }
  return Object.freeze({
    schema,
    context: catalogs.length
      ? parseQueryContractContext({
          ...context,
          schemaHash: calculateSchemaHash(schema),
          profileHash: queryContractDigest({
            baseProfileHash: context.profileHash,
            projectCatalogs: catalogs.map((catalog) => catalog.digest),
          }),
        })
      : context,
  });
}
