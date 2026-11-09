import { randomUUID } from "node:crypto";
import { lstat, opendir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  cacheDigestPattern,
  cacheDirectory,
  cacheMissing,
  cacheTemporaryPattern,
  readCacheFile,
  writeCacheFile,
} from "./cache-files.js";
import { canonicalContractData, queryContractDigest } from "./canonical.js";
import {
  type AnalysisContextScope,
  analysisContextScopeKey,
  assertContextScope,
  parseAnalysisContextScope,
} from "./context-scope.js";
import { parseQueryContract, parseQueryContractContext, serializeQueryContract } from "./contracts.js";
import {
  type LiveAnalysisFailure,
  type LiveAnalysisOutcome,
  type LiveAnalysisRequest,
  parseLiveAnalysisFailure,
  parseLiveAnalysisOutcome,
  parseLiveAnalysisRequest,
} from "./live.js";
import { type ProjectCatalogClosure, parseProjectCatalogClosure } from "./project-catalog.js";
import {
  type ProjectCatalogCacheLookup,
  type ProjectCatalogCacheQuery,
  projectCatalogCacheSelection,
} from "./project-catalog-cache.js";
import {
  parseRecordedAnalysisQuery,
  parseRecordedQueryContract,
  type RecordedAnalysisQuery,
  recordedAnalysisQueryKey,
} from "./recorded-query.js";

export interface AnalysisCacheOptions {
  /** Explicit private cache root, conventionally .typed-sql/cache/analysis/v1. */
  readonly directory: string;
  /** Sanitized workspace/config namespace; never credentials or a connection string. */
  readonly workspaceContext: string;
  readonly maxEntries?: number;
  readonly maxNamespaces?: number;
  readonly maxObjectBytes?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}
export interface AnalysisCacheToken {
  readonly formatVersion: 1;
  readonly ownerInstance: string;
  readonly workspaceContext: string;
  readonly epoch: string;
  readonly requestKey: string;
  readonly entryRevision: string | null;
}
export interface AnalysisCacheInspection {
  readonly formatVersion: 1;
  readonly status: "absent" | "present";
  readonly freshness: "unverified";
  /** Index references, not a substitute for qualified contract lookup. */
  readonly indexedContracts: readonly {
    readonly digest: string;
    readonly contextHash: string;
    readonly recordedAt: number;
  }[];
  readonly indexedCatalogs: readonly { readonly digest: string; readonly contextHash: string }[];
  readonly outcomes: Readonly<Record<string, number>>;
  readonly failures: readonly (LiveAnalysisFailure & { readonly contextHash: string; readonly recordedAt: number })[];
  readonly contexts: readonly {
    readonly scopeHash: string;
    readonly contextHash: string;
    readonly status: "usable" | "stale";
    readonly observedAt: number;
  }[];
}
export interface AnalysisCacheLookup {
  readonly token: AnalysisCacheToken;
  readonly cached?: {
    readonly outcome: LiveAnalysisOutcome;
    readonly recordedAt: number;
    /** Matching bytes do not establish current remote freshness. */
    readonly freshness: "unverified";
  };
}
export interface AnalysisCache {
  lookupProjectCatalog(query: ProjectCatalogCacheQuery): Promise<ProjectCatalogCacheLookup>;
  publishProjectCatalog(input: {
    readonly token: AnalysisCacheToken;
    readonly baseToken: AnalysisCacheToken;
    readonly query: ProjectCatalogCacheQuery;
    readonly closure: ProjectCatalogClosure;
  }): Promise<
    | { readonly status: "published"; readonly token: AnalysisCacheToken }
    | { readonly status: "superseded" | "capacity" }
  >;
  areTokensCurrent(tokens: readonly AnalysisCacheToken[]): Promise<boolean>;
  lookupContext(
    scope: AnalysisContextScope,
    recordedContext?: import("./contracts.js").QueryContractContext,
  ): Promise<AnalysisContextLookup>;
  publishContext(input: {
    readonly token: AnalysisCacheToken;
    readonly scope: AnalysisContextScope;
    readonly context: import("./contracts.js").QueryContractContext;
    readonly previousContext?: import("./contracts.js").QueryContractContext;
  }): Promise<
    | { readonly status: "published"; readonly token: AnalysisCacheToken }
    | { readonly status: "superseded" | "capacity" }
  >;
  /** Contract-first lookup; no analyzer claim or database access is required. */
  lookupRecorded(query: RecordedAnalysisQuery): Promise<AnalysisCacheLookup>;
  lookup(request: LiveAnalysisRequest): Promise<AnalysisCacheLookup>;
  publish(input: {
    readonly token: AnalysisCacheToken;
    readonly request: LiveAnalysisRequest;
    readonly outcome: LiveAnalysisOutcome;
  }): Promise<
    { readonly status: "published"; readonly revision: string } | { readonly status: "superseded" | "capacity" }
  >;
  /** Rotate this workspace/config epoch; old in-flight producers cannot repopulate it. */
  invalidate(): Promise<void>;
  /** Remember a disproved recorded context even when no query is currently open. */
  retireContext(context: import("./contracts.js").QueryContractContext): Promise<void>;
  /** Preserve all indexed objects, other namespaces and unrelated files. */
  prune(options?: {
    readonly retentionMs?: number;
  }): Promise<{ readonly removed: number; readonly bytes: number; readonly retainedBytes: number }>;
}
export interface AnalysisContextLookup {
  readonly token: AnalysisCacheToken;
  readonly recorded?: {
    readonly context: import("./contracts.js").QueryContractContext;
    readonly status: "usable" | "stale";
    readonly observedAt: number;
    readonly freshness: "unverified";
  };
}
interface ContextHead {
  readonly scopeHash: string;
  readonly contextHash: string;
  readonly revision: string;
  readonly observedAt: number;
  readonly status: "usable" | "stale";
}
type CacheResult =
  | LiveAnalysisFailure
  | { readonly kind: "usable-recorded-context"; readonly contractDigest: string }
  | { readonly kind: "project-catalog"; readonly catalogDigest: string; readonly scopeHash: string };
interface Entry {
  readonly requestKey: string;
  readonly revision: string;
  readonly contextHash: string;
  readonly recordedAt: number;
  readonly result: CacheResult;
}
interface Index {
  readonly formatVersion: 1;
  readonly workspaceContext: string;
  readonly epoch: string;
  readonly entries: readonly Entry[];
  readonly heads?: readonly ContextHead[];
  readonly digest: string;
}
interface Owner {
  readonly formatVersion: 1;
  readonly owner: "@typed-sql/analysis";
  readonly instance: string;
}
const nonce = () => queryContractDigest(randomUUID());
// A bounded, conservative replacement when individual retirement history no longer fits.
const retirementBarrierKey = queryContractDigest({ kind: "unobserved-contexts-require-refresh-v1" });
const isRetirementBarrier = (entry: Entry) =>
  entry.requestKey === retirementBarrierKey && entry.result.kind === "stale-context";
function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !cacheDigestPattern.test(value))
    throw new TypeError("Invalid analysis cache identity");
}
function shape(input: unknown, keys: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== keys)
    throw new TypeError("Invalid analysis cache record");
  return input as Record<string, unknown>;
}
function timestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid analysis cache timestamp");
}
function owner(input: unknown): Owner {
  const value = shape(input, "formatVersion,instance,owner");
  if (value.formatVersion !== 1 || value.owner !== "@typed-sql/analysis")
    throw new TypeError("Analysis cache ownership/version differs");
  hash(value.instance);
  return Object.freeze(value) as unknown as Owner;
}
function index(input: unknown, expectedWorkspace: string, maxEntries: number): Index {
  const value = shape(
    input,
    input && typeof input === "object" && Object.hasOwn(input, "heads")
      ? "digest,entries,epoch,formatVersion,heads,workspaceContext"
      : "digest,entries,epoch,formatVersion,workspaceContext",
  );
  if (
    value.formatVersion !== 1 ||
    value.workspaceContext !== expectedWorkspace ||
    !Array.isArray(value.entries) ||
    value.entries.length > maxEntries
  )
    throw new TypeError("Analysis cache index/version/limit differs");
  hash(value.epoch);
  hash(value.digest);
  if (value.heads !== undefined) {
    if (!Array.isArray(value.heads) || value.heads.length > maxEntries)
      throw new TypeError("Analysis context head limit differs");
    let previous = "";
    for (const item of value.heads) {
      const head = shape(item, "contextHash,observedAt,revision,scopeHash,status");
      hash(head.scopeHash);
      hash(head.contextHash);
      hash(head.revision);
      timestamp(head.observedAt);
      if (!["usable", "stale"].includes(head.status as string) || head.scopeHash <= previous)
        throw new TypeError("Invalid analysis context head order or status");
      previous = head.scopeHash;
    }
  }
  let previous = "";
  for (const item of value.entries) {
    const entry = shape(item, "contextHash,recordedAt,requestKey,result,revision");
    hash(entry.requestKey);
    hash(entry.revision);
    hash(entry.contextHash);
    timestamp(entry.recordedAt);
    if (entry.requestKey <= previous) throw new TypeError("Analysis cache keys must be sorted and unique");
    previous = entry.requestKey;
    const result = entry.result;
    if (result && typeof result === "object" && "kind" in result && result.kind === "usable-recorded-context") {
      const reference = shape(result, "contractDigest,kind");
      hash(reference.contractDigest);
    } else if (result && typeof result === "object" && "kind" in result && result.kind === "project-catalog") {
      const reference = shape(result, "catalogDigest,kind,scopeHash");
      hash(reference.catalogDigest);
      hash(reference.scopeHash);
    } else {
      const failure = parseLiveAnalysisFailure(entry.result);
      if (failure.kind === "unavailable" && failure.retry === "transport")
        throw new TypeError("Transient transport failures are not persisted");
    }
  }
  const { digest, ...body } = value;
  if (queryContractDigest(body) !== digest) throw new TypeError("Analysis cache index digest differs");
  return value as unknown as Index;
}
function token(input: AnalysisCacheToken): AnalysisCacheToken {
  const value = shape(
    JSON.parse(canonicalContractData(input)),
    "entryRevision,epoch,formatVersion,ownerInstance,requestKey,workspaceContext",
  );
  if (value.formatVersion !== 1) throw new TypeError("Invalid analysis cache token version");
  for (const key of ["epoch", "ownerInstance", "requestKey", "workspaceContext"]) hash(value[key]);
  if (value.entryRevision !== null) hash(value.entryRevision);
  return Object.freeze(value) as unknown as AnalysisCacheToken;
}
async function names(path: string): Promise<string[]> {
  const result: string[] = [];
  const directory = await opendir(path);
  try {
    for (;;) {
      const entry = await directory.read();
      if (!entry) break;
      if (result.length >= 65_535) throw new TypeError("Analysis cache directory exceeds entry limit");
      result.push(entry.name);
    }
  } finally {
    await directory.close();
  }
  return result;
}

// The filesystem lock coordinates processes. A FIFO per resolved cache directory prevents handles
// in one process from exhausting its retry budget by competing with each other.
const publicationQueues = new Map<string, Promise<void>>();

/** Read one validated index snapshot without creating a cache, taking a write lock or connecting. */
export async function inspectAnalysisCache(options: {
  readonly directory: string;
  readonly workspaceContext: string;
}): Promise<AnalysisCacheInspection> {
  hash(options.workspaceContext);
  const root = resolve(options.directory),
    limit = 8 * 1024 * 1024;
  const absent = (): AnalysisCacheInspection =>
    Object.freeze({
      formatVersion: 1,
      status: "absent",
      freshness: "unverified",
      indexedContracts: Object.freeze([]),
      indexedCatalogs: Object.freeze([]),
      outcomes: Object.freeze({}),
      failures: Object.freeze([]),
      contexts: Object.freeze([]),
    });
  const directory = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Unsafe analysis cache directory");
  };
  try {
    await directory(root);
  } catch (error) {
    if (cacheMissing(error)) return absent();
    throw error;
  }
  const ownership = () => readCacheFile(join(root, "ownership.json"), limit).then((text) => owner(JSON.parse(text)));
  const before = await ownership();
  let current: Index;
  try {
    await directory(join(root, "indexes"));
    current = index(
      JSON.parse(await readCacheFile(join(root, "indexes", `${options.workspaceContext}.json`), limit)),
      options.workspaceContext,
      65_535,
    );
  } catch (error) {
    if (cacheMissing(error)) return absent();
    throw error;
  }
  if ((await ownership()).instance !== before.instance) throw new TypeError("Analysis cache owner instance changed");
  const outcomes: Record<string, number> = {};
  for (const entry of current.entries) outcomes[entry.result.kind] = (outcomes[entry.result.kind] ?? 0) + 1;
  return Object.freeze({
    formatVersion: 1,
    status: "present",
    freshness: "unverified",
    indexedContracts: Object.freeze(
      current.entries.flatMap((entry) =>
        entry.result.kind === "usable-recorded-context"
          ? [
              Object.freeze({
                digest: entry.result.contractDigest,
                contextHash: entry.contextHash,
                recordedAt: entry.recordedAt,
              }),
            ]
          : [],
      ),
    ),
    indexedCatalogs: Object.freeze(
      current.entries.flatMap((entry) =>
        entry.result.kind === "project-catalog"
          ? [Object.freeze({ digest: entry.result.catalogDigest, contextHash: entry.contextHash })]
          : [],
      ),
    ),
    outcomes: Object.freeze(outcomes),
    failures: Object.freeze(
      current.entries.flatMap((entry) =>
        entry.result.kind === "usable-recorded-context" || entry.result.kind === "project-catalog"
          ? []
          : [Object.freeze({ ...entry.result, contextHash: entry.contextHash, recordedAt: entry.recordedAt })],
      ),
    ),
    contexts: Object.freeze(
      (current.heads ?? []).map(({ scopeHash, contextHash, status, observedAt }) =>
        Object.freeze({ scopeHash, contextHash, status, observedAt }),
      ),
    ),
  });
}

/** Opens owned disposable storage. It never connects, executes SQL, or writes durable compiler inputs. */
export async function openAnalysisCache(options: AnalysisCacheOptions): Promise<AnalysisCache> {
  hash(options.workspaceContext);
  const root = resolve(options.directory),
    workspaceContext = options.workspaceContext;
  const maxEntries = options.maxEntries ?? 4096,
    maxNamespaces = options.maxNamespaces ?? 128,
    maxObjectBytes = options.maxObjectBytes ?? 8 * 1024 * 1024,
    maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 65_535 ||
    !Number.isSafeInteger(maxNamespaces) ||
    maxNamespaces < 1 ||
    maxNamespaces > 4096 ||
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes < 1024 ||
    maxObjectBytes > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < maxObjectBytes ||
    maxBytes > Number.MAX_SAFE_INTEGER
  )
    throw new RangeError("Invalid analysis cache limits");
  const now = () => {
    const value = (options.now ?? Date.now)();
    timestamp(value);
    return value;
  };
  const path = {
    ownership: join(root, "ownership.json"),
    usage: join(root, "usage.json"),
    locks: join(root, "locks"),
    lock: join(root, "locks/publication.lock"),
    staging: join(root, "staging"),
    indexes: join(root, "indexes"),
    index: join(root, "indexes", `${workspaceContext}.json`),
    contexts: join(root, "contexts"),
    queries: join(root, "queries/objects"),
    catalogs: join(root, "catalogs/objects"),
  };
  await cacheDirectory(root);
  // Do not claim an existing unrelated directory. A crashed first initializer may leave locks/ only.
  try {
    owner(JSON.parse(await readCacheFile(path.ownership, maxObjectBytes)));
  } catch (error) {
    if (!cacheMissing(error)) throw error;
    if ((await names(root)).some((name) => name !== "locks" && name !== "staging")) {
      // Another initializer may have published ownership between the failed read and listing.
      // Validate that marker before classifying its newly created layout as foreign data.
      try {
        owner(JSON.parse(await readCacheFile(path.ownership, maxObjectBytes)));
      } catch (current) {
        if (!cacheMissing(current)) throw current;
        throw new TypeError("Refusing unowned analysis cache directory");
      }
    }
  }
  await cacheDirectory(path.locks);
  let instance: string | undefined;
  const withLock = async <Value>(run: (assertLock: () => Promise<void>) => Promise<Value>): Promise<Value> => {
    const previous = publicationQueues.get(root) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    publicationQueues.set(root, queued);
    await previous;
    try {
      await cacheDirectory(root);
      await cacheDirectory(path.locks);
      const existing = await lstat(path.lock).catch((error) => {
        if (!cacheMissing(error)) throw error;
        return undefined;
      });
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
        throw new TypeError("Unsafe analysis cache lock");
      let compromised: Error | undefined;
      const { lock } = await import("proper-lockfile");
      const release = await lock(root, {
        realpath: false,
        lockfilePath: path.lock,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 8, minTimeout: 10, maxTimeout: 100, factor: 1.5, randomize: true },
        onCompromised: (error) => {
          compromised = error;
        },
      });
      try {
        const leased = await lstat(path.lock);
        const assertLock = async () => {
          if (compromised) throw new Error("Analysis cache publication lock lost", { cause: compromised });
          const current = await lstat(path.lock);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.ino !== leased.ino ||
            current.dev !== leased.dev
          )
            throw new Error("Analysis cache publication lock replaced");
        };
        await assertLock();
        return await run(assertLock);
      } finally {
        await release();
      }
    } finally {
      releaseQueue();
      if (publicationQueues.get(root) === queued) publicationQueues.delete(root);
    }
  };
  const layout = async () => {
    await cacheDirectory(root);
    const current = owner(JSON.parse(await readCacheFile(path.ownership, maxObjectBytes)));
    if (current.instance !== instance) throw new TypeError("Analysis cache owner instance changed");
    for (const directory of [
      path.staging,
      path.indexes,
      path.contexts,
      join(root, "queries"),
      path.queries,
      join(root, "catalogs"),
      path.catalogs,
    ])
      await cacheDirectory(directory);
  };
  const write = (file: string, text: string, immutable: boolean, assertLock: () => Promise<void>) =>
    writeCacheFile({ path: file, staging: path.staging, text, limit: maxObjectBytes, immutable, assertLock });
  const readUsage = async () => {
    const value = shape(JSON.parse(await readCacheFile(path.usage, maxObjectBytes)), "bytes,digest,formatVersion");
    if (value.formatVersion !== 1 || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0)
      throw new TypeError("Invalid analysis cache reservation ledger");
    const { digest, ...body } = value;
    if (queryContractDigest(body) !== digest) throw new TypeError("Analysis cache reservation digest differs");
    return value.bytes as number;
  };
  const writeUsage = (bytes: number, assertLock: () => Promise<void>) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Invalid analysis cache reservation size");
    const body = { formatVersion: 1, bytes };
    return write(
      path.usage,
      `${canonicalContractData({ ...body, digest: queryContractDigest(body) })}\n`,
      false,
      assertLock,
    );
  };
  const fileSize = async (file: string) => {
    const stat = await lstat(file).catch((error) => {
      if (!cacheMissing(error)) throw error;
      return undefined;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new TypeError("Unsafe analysis cache object");
    return stat?.size ?? 0;
  };
  const indexText = (epoch: string, entries: readonly Entry[], heads: readonly ContextHead[] = []) => {
    const body = {
      formatVersion: 1,
      workspaceContext,
      epoch,
      entries: [...entries].sort((a, b) => a.requestKey.localeCompare(b.requestKey)),
      ...(heads.length ? { heads: [...heads].sort((a, b) => a.scopeHash.localeCompare(b.scopeHash)) } : {}),
    };
    const parsed = index({ ...body, digest: queryContractDigest(body) }, workspaceContext, maxEntries);
    return `${canonicalContractData(parsed)}\n`;
  };
  const writeIndex = async (
    epoch: string,
    entries: readonly Entry[],
    assertLock: () => Promise<void>,
    heads: readonly ContextHead[] = [],
  ) => {
    const text = indexText(epoch, entries, heads),
      before = await readUsage(),
      previousBytes = await fileSize(path.index);
    const delta = Buffer.byteLength(text) - previousBytes;
    if (delta > 0) await writeUsage(before + delta, assertLock);
    await write(path.index, text, false, assertLock);
    if (delta < 0) await writeUsage(Math.max(0, before + delta), assertLock);
  };
  const readIndex = () =>
    readCacheFile(path.index, maxObjectBytes).then((text) => index(JSON.parse(text), workspaceContext, maxEntries));
  const writeRetirementIndex = async (
    current: Index,
    retired: Entry,
    assertLock: () => Promise<void>,
    heads: readonly ContextHead[] = current.heads ?? [],
  ) => {
    const epoch = nonce();
    let entries = [
      ...current.entries.filter(
        (entry) => entry.result.kind === "stale-context" && entry.requestKey !== retired.requestKey,
      ),
      retired,
    ];
    const barrier = entries.find(isRetirementBarrier);
    if (barrier) entries = [barrier];
    if (entries.length > maxEntries || Buffer.byteLength(indexText(epoch, entries, heads)) > maxObjectBytes) {
      entries = [
        {
          requestKey: retirementBarrierKey,
          contextHash: retirementBarrierKey,
          revision: nonce(),
          recordedAt: now(),
          result: { kind: "stale-context", code: "context-history-compacted" },
        },
      ];
      heads = [];
    }
    await writeIndex(epoch, entries, assertLock, heads);
  };
  await withLock(async (assertLock) => {
    try {
      instance = owner(JSON.parse(await readCacheFile(path.ownership, maxObjectBytes))).instance;
    } catch (error) {
      if (!cacheMissing(error)) throw error;
      if ((await names(root)).some((name) => name !== "locks"))
        throw new TypeError("Refusing unowned analysis cache directory");
      instance = nonce();
      // Exclusive ownership creation precedes every other cache artifact.
      await cacheDirectory(path.staging);
      await write(
        path.ownership,
        `${canonicalContractData({ formatVersion: 1, owner: "@typed-sql/analysis", instance })}\n`,
        true,
        assertLock,
      );
    }
    await layout();
    try {
      await readUsage();
    } catch (error) {
      if (!cacheMissing(error)) throw error;
      await writeUsage(
        (await objects()).reduce((sum, file) => sum + file.bytes, 0),
        assertLock,
      );
    }
    try {
      await readIndex();
    } catch (error) {
      if (!cacheMissing(error)) throw error;
      if ((await names(path.indexes)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).length >= maxNamespaces)
        throw new RangeError("Analysis cache namespace limit");
      const epoch = nonce(),
        text = indexText(epoch, []);
      if ((await readUsage()) + Buffer.byteLength(text) > maxBytes)
        throw new RangeError("Analysis cache byte capacity");
      await writeIndex(epoch, [], assertLock);
    }
  });
  async function objects() {
    const files: {
      path: string;
      bytes: number;
      modified: number;
      digest: string;
      kind: "query" | "context" | "index" | "staging" | "catalog";
    }[] = [];
    for (const [directory, kind] of [
      [path.queries, "query"],
      [path.catalogs, "catalog"],
      [path.contexts, "context"],
      [path.indexes, "index"],
      [path.staging, "staging"],
    ] as const) {
      for (const name of await names(directory)) {
        if (!(kind === "staging" ? cacheTemporaryPattern.test(name) : /^[a-f0-9]{64}\.json$/u.test(name))) continue;
        const file = join(directory, name),
          stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Unsafe analysis cache object");
        files.push({ path: file, bytes: stat.size, modified: stat.mtimeMs, digest: name.slice(0, -5), kind });
      }
    }
    return files;
  }
  async function lookupRecorded(query: RecordedAnalysisQuery, staticClaimHash?: string): Promise<AnalysisCacheLookup> {
    const requestKey = recordedAnalysisQueryKey(query),
      expectedContextHash = queryContractDigest(query.context);
    return withLock(async (assertLock) => {
      await layout();
      await readUsage();
      const current = await readIndex(),
        entry = current.entries.find((item) => item.requestKey === requestKey);
      const captured = token({
        formatVersion: 1,
        ownerInstance: instance!,
        workspaceContext,
        epoch: current.epoch,
        requestKey,
        entryRevision: entry?.revision ?? null,
      });
      const selected =
        current.entries.find(
          (item) => item.result.kind === "stale-context" && item.contextHash === expectedContextHash,
        ) ??
        entry ??
        current.entries.find(isRetirementBarrier);
      if (!selected) return Object.freeze({ token: captured });
      if (selected.contextHash !== expectedContextHash && !isRetirementBarrier(selected))
        throw new TypeError("Analysis cache context identity differs");
      let result: LiveAnalysisOutcome;
      if (selected.result.kind === "usable-recorded-context") {
        const contract = parseQueryContract(
          JSON.parse(await readCacheFile(join(path.queries, `${selected.result.contractDigest}.json`), maxObjectBytes)),
        );
        if (contract.digest !== selected.result.contractDigest)
          throw new TypeError("Analysis cache object digest differs");
        const context = parseQueryContractContext(
          JSON.parse(await readCacheFile(join(path.contexts, `${selected.contextHash}.json`), maxObjectBytes)),
        );
        if (queryContractDigest(context) !== selected.contextHash)
          throw new TypeError("Analysis cache context digest differs");
        const matched = parseRecordedQueryContract(contract, query);
        if (staticClaimHash !== undefined && matched.qualification!.staticClaimHash !== staticClaimHash) {
          const epoch = current.epoch,
            revision = nonce(),
            recordedAt = now();
          const result = { kind: "partial", code: "static-claim-changed" } as const;
          const retired: Entry = { requestKey, revision, recordedAt, contextHash: expectedContextHash, result };
          await writeIndex(
            epoch,
            [...current.entries.filter((item) => item.requestKey !== requestKey), retired],
            assertLock,
            current.heads,
          );
          return Object.freeze({
            token: token({ ...captured, epoch, entryRevision: revision }),
            cached: Object.freeze({ outcome: result, recordedAt, freshness: "unverified" as const }),
          });
        }
        result = Object.freeze({ kind: "usable-recorded-context", contract: matched });
      } else result = parseLiveAnalysisFailure(selected.result);
      return Object.freeze({
        token: captured,
        cached: Object.freeze({ outcome: result, recordedAt: selected.recordedAt, freshness: "unverified" as const }),
      });
    });
  }
  return Object.freeze({
    async lookupProjectCatalog(input) {
      const { scope, scopeHash, requestKey } = projectCatalogCacheSelection(input);
      return withLock(async () => {
        await layout();
        await readUsage();
        const current = await readIndex();
        const entry = current.entries.find((item) => item.requestKey === requestKey);
        const captured = token({
          formatVersion: 1,
          ownerInstance: instance!,
          workspaceContext,
          epoch: current.epoch,
          requestKey,
          entryRevision: entry?.revision ?? null,
        });
        if (!entry) return Object.freeze({ token: captured });
        if (entry.result.kind !== "project-catalog" || entry.result.scopeHash !== scopeHash)
          throw new TypeError("Analysis cache catalog selection differs");
        const closure = parseProjectCatalogClosure(
          JSON.parse(await readCacheFile(join(path.catalogs, `${entry.result.catalogDigest}.json`), maxObjectBytes)),
        );
        if (
          closure.digest !== entry.result.catalogDigest ||
          queryContractDigest(closure.baseContext) !== entry.contextHash
        )
          throw new TypeError("Analysis cache catalog identity differs");
        assertContextScope(closure.baseContext, scope);
        const head = current.heads?.find((item) => item.scopeHash === scopeHash);
        if (
          !head ||
          head.status === "stale" ||
          head.contextHash !== entry.contextHash ||
          current.entries.some((item) => item.contextHash === entry.contextHash && item.result.kind === "stale-context")
        )
          return Object.freeze({ token: captured, blocked: "stale-context" as const });
        return Object.freeze({
          token: captured,
          cached: Object.freeze({ closure, recordedAt: entry.recordedAt, freshness: "unverified" as const }),
        });
      });
    },
    async publishProjectCatalog(input) {
      const { scope, scopeHash, requestKey } = projectCatalogCacheSelection(input.query);
      const closure = parseProjectCatalogClosure(input.closure);
      const expected = token(input.token),
        base = token(input.baseToken);
      assertContextScope(closure.baseContext, scope);
      for (const [captured, key] of [
        [expected, requestKey],
        [base, scopeHash],
      ] as const)
        if (
          captured.ownerInstance !== instance ||
          captured.workspaceContext !== workspaceContext ||
          captured.requestKey !== key
        )
          throw new TypeError("Analysis cache catalog publication token differs");
      return withLock(async (assertLock) => {
        await layout();
        const current = await readIndex();
        const previous = current.entries.find((item) => item.requestKey === requestKey);
        const head = current.heads?.find((item) => item.scopeHash === scopeHash);
        const contextHash = queryContractDigest(closure.baseContext);
        if (
          current.epoch !== expected.epoch ||
          current.epoch !== base.epoch ||
          (previous?.revision ?? null) !== expected.entryRevision ||
          !head ||
          head.revision !== base.entryRevision ||
          head.status !== "usable" ||
          head.contextHash !== contextHash ||
          current.entries.some((item) => item.contextHash === contextHash && item.result.kind === "stale-context")
        )
          return { status: "superseded" as const };
        if (!previous && current.entries.length >= maxEntries) return { status: "capacity" as const };
        const unchanged =
          previous?.result.kind === "project-catalog" &&
          previous.result.catalogDigest === closure.digest &&
          previous.result.scopeHash === scopeHash &&
          previous.contextHash === contextHash;
        const revision = unchanged ? previous.revision : nonce();
        const entry: Entry = {
          requestKey,
          contextHash,
          revision,
          recordedAt: now(),
          result: { kind: "project-catalog", catalogDigest: closure.digest, scopeHash },
        };
        const text = indexText(
          current.epoch,
          [...current.entries.filter((item) => item.requestKey !== requestKey), entry],
          current.heads,
        );
        const objectText = `${canonicalContractData(closure)}\n`;
        const file = join(path.catalogs, `${closure.digest}.json`);
        const before = await readUsage(),
          previousBytes = await fileSize(path.index);
        const added =
          Math.max(0, Buffer.byteLength(text) - previousBytes) +
          (!(await fileSize(file)) ? Buffer.byteLength(objectText) : 0);
        if (
          Buffer.byteLength(text) > maxObjectBytes ||
          Buffer.byteLength(objectText) > maxObjectBytes ||
          before + added > maxBytes
        )
          return { status: "capacity" as const };
        if (added) await writeUsage(before + added, assertLock);
        await write(file, objectText, true, assertLock);
        await write(path.index, text, false, assertLock);
        const released = Math.max(0, previousBytes - Buffer.byteLength(text));
        if (released) await writeUsage(Math.max(0, before + added - released), assertLock);
        return { status: "published" as const, token: token({ ...expected, entryRevision: revision }) };
      });
    },
    async areTokensCurrent(inputs) {
      if (inputs.length > 65_535) throw new RangeError("Analysis cache snapshot token limit exceeded");
      const expected = inputs.map(token);
      return withLock(async () => {
        await layout();
        const current = await readIndex(),
          revisions = new Map<string, string>([
            ...current.entries.map((entry) => [entry.requestKey, entry.revision] as const),
            ...(current.heads ?? []).map((head) => [head.scopeHash, head.revision] as const),
          ]);
        return expected.every(
          (item) =>
            item.ownerInstance === instance &&
            item.workspaceContext === workspaceContext &&
            item.epoch === current.epoch &&
            (revisions.get(item.requestKey) ?? null) === item.entryRevision,
        );
      });
    },
    async lookupContext(input: AnalysisContextScope, recordedContext): Promise<AnalysisContextLookup> {
      const scope = parseAnalysisContextScope(input),
        key = analysisContextScopeKey(scope);
      const recorded = recordedContext === undefined ? undefined : parseQueryContractContext(recordedContext);
      if (recorded) assertContextScope(recorded, scope);
      const recordedHash = recorded ? queryContractDigest(recorded) : undefined;
      return withLock(async () => {
        await layout();
        await readUsage();
        const current = await readIndex(),
          head = current.heads?.find((item) => item.scopeHash === key);
        const captured = token({
          formatVersion: 1,
          ownerInstance: instance!,
          workspaceContext,
          epoch: current.epoch,
          requestKey: key,
          entryRevision: head?.revision ?? null,
        });
        if (!head) {
          const retired =
            recorded &&
            current.entries.find(
              (item) =>
                (item.contextHash === recordedHash && item.result.kind === "stale-context") ||
                isRetirementBarrier(item),
            );
          if (recorded && retired)
            return Object.freeze({
              token: captured,
              recorded: Object.freeze({
                context: recorded,
                status: "stale" as const,
                observedAt: retired.recordedAt,
                freshness: "unverified" as const,
              }),
            });
          return Object.freeze({ token: captured });
        }
        const context = parseQueryContractContext(
          JSON.parse(await readCacheFile(join(path.contexts, `${head.contextHash}.json`), maxObjectBytes)),
        );
        if (queryContractDigest(context) !== head.contextHash)
          throw new TypeError("Analysis context head digest differs");
        assertContextScope(context, scope);
        const stale =
          head.status === "stale" ||
          current.entries.some((item) => item.contextHash === head.contextHash && item.result.kind === "stale-context");
        return Object.freeze({
          token: captured,
          recorded: Object.freeze({
            context,
            status: stale ? ("stale" as const) : ("usable" as const),
            observedAt: head.observedAt,
            freshness: "unverified" as const,
          }),
        });
      });
    },
    async publishContext(input) {
      const scope = parseAnalysisContextScope(input.scope),
        context = parseQueryContractContext(input.context),
        expected = token(input.token),
        key = analysisContextScopeKey(scope);
      assertContextScope(context, scope);
      const previousContext =
        input.previousContext === undefined ? undefined : parseQueryContractContext(input.previousContext);
      if (previousContext) assertContextScope(previousContext, scope);
      if (
        expected.requestKey !== key ||
        expected.workspaceContext !== workspaceContext ||
        expected.ownerInstance !== instance
      )
        throw new TypeError("Analysis context publication token differs");
      return withLock(async (assertLock) => {
        await layout();
        const current = await readIndex(),
          previous = current.heads?.find((head) => head.scopeHash === key);
        if (current.epoch !== expected.epoch || (previous?.revision ?? null) !== expected.entryRevision)
          return { status: "superseded" as const };
        const heads = current.heads ?? [];
        const contextHash = queryContractDigest(context);
        const unchanged =
          previous?.status === "usable" &&
          previous.contextHash === contextHash &&
          !current.entries.some((item) => item.contextHash === contextHash && item.result.kind === "stale-context");
        // Observation time can advance without invalidating queries bound to identical evidence.
        const head: ContextHead = {
          scopeHash: key,
          contextHash,
          revision: unchanged ? previous.revision : nonce(),
          observedAt: now(),
          status: "usable",
        };
        const priorHash = previous?.contextHash ?? (previousContext ? queryContractDigest(previousContext) : undefined);
        const changed = priorHash !== undefined && priorHash !== contextHash;
        const epoch = changed ? nonce() : current.epoch;
        const retired: Entry | undefined = changed
          ? {
              requestKey: queryContractDigest({ kind: "retired-context", contextHash: priorHash }),
              contextHash: priorHash!,
              revision: nonce(),
              recordedAt: now(),
              result: { kind: "stale-context", code: "context-changed" },
            }
          : undefined;
        const entries = current.entries.filter(
          (item) =>
            item.contextHash !== (changed ? priorHash : "") &&
            (item.result.kind !== "stale-context" || item.contextHash !== contextHash),
        );
        if (retired && !entries.some(isRetirementBarrier)) entries.push(retired);
        const capacity = async () => {
          if (retired)
            await writeRetirementIndex(
              current,
              retired,
              assertLock,
              heads.map((head) =>
                head.contextHash === priorHash ? { ...head, status: "stale", revision: nonce() } : head,
              ),
            );
          return { status: "capacity" as const };
        };
        if (entries.length > maxEntries || (!previous && heads.length >= maxEntries)) return capacity();
        const text = indexText(epoch, entries, [...heads.filter((item) => item.scopeHash !== key), head]);
        const contextText = `${canonicalContractData(context)}\n`,
          contextFile = join(path.contexts, `${contextHash}.json`);
        const before = await readUsage(),
          previousBytes = await fileSize(path.index),
          added =
            Math.max(0, Buffer.byteLength(text) - previousBytes) +
            (!(await fileSize(contextFile)) ? Buffer.byteLength(contextText) : 0);
        if (
          Buffer.byteLength(text) > maxObjectBytes ||
          Buffer.byteLength(contextText) > maxObjectBytes ||
          before + added > maxBytes
        )
          return capacity();
        if (added) await writeUsage(before + added, assertLock);
        await write(contextFile, contextText, true, assertLock);
        await write(path.index, text, false, assertLock);
        if (previousBytes > Buffer.byteLength(text))
          await writeUsage(Math.max(0, before + added - previousBytes + Buffer.byteLength(text)), assertLock);
        return { status: "published" as const, token: token({ ...expected, epoch, entryRevision: head.revision }) };
      });
    },
    lookupRecorded(input: RecordedAnalysisQuery) {
      return lookupRecorded(parseRecordedAnalysisQuery(input));
    },
    async lookup(input: LiveAnalysisRequest): Promise<AnalysisCacheLookup> {
      const request = parseLiveAnalysisRequest(input);
      return lookupRecorded(recordedQuery(request), request.staticClaim.digest);
    },
    async publish(input) {
      const request = parseLiveAnalysisRequest(input.request),
        expected = token(input.token),
        result = parseLiveAnalysisOutcome(input.outcome, request);
      if (result.kind === "unavailable")
        throw new TypeError("Transient availability and configuration failures are not persisted");
      if (
        expected.requestKey !== recordedAnalysisQueryKey(recordedQuery(request)) ||
        expected.workspaceContext !== workspaceContext ||
        expected.ownerInstance !== instance
      )
        throw new TypeError("Analysis cache publication token differs");
      return withLock(async (assertLock) => {
        await layout();
        const current = await readIndex(),
          previous = current.entries.find((item) => item.requestKey === expected.requestKey);
        if (current.epoch !== expected.epoch || (previous?.revision ?? null) !== expected.entryRevision)
          return { status: "superseded" as const };
        if (
          result.kind === "partial" &&
          previous &&
          (["conflict", "rejected", "stale-context"].includes(previous.result.kind) ||
            (previous.result.kind === "partial" && previous.result.code === "static-claim-changed"))
        )
          return { status: "superseded" as const };
        const contextHash = queryContractDigest(request.staticClaim.context);
        const retainedEntries =
          result.kind === "stale-context"
            ? current.entries.filter((item) => item.result.kind === "stale-context" && item.contextHash !== contextHash)
            : result.kind === "usable-recorded-context"
              ? current.entries.filter(
                  (item) => item.result.kind !== "stale-context" || item.contextHash !== contextHash,
                )
              : current.entries;
        const recordedAt = now();
        const stored: CacheResult =
          result.kind === "usable-recorded-context"
            ? { kind: result.kind, contractDigest: result.contract.digest }
            : result;
        const revision = nonce(),
          entry: Entry = { requestKey: expected.requestKey, revision, recordedAt, contextHash, result: stored };
        if (!previous && retainedEntries.length >= maxEntries) {
          if (result.kind === "stale-context")
            await writeRetirementIndex(
              current,
              entry,
              assertLock,
              current.heads?.map((head) =>
                head.contextHash === contextHash ? { ...head, status: "stale", revision: nonce() } : head,
              ),
            );
          return { status: "capacity" as const };
        }
        const entries = [...retainedEntries.filter((item) => item.requestKey !== entry.requestKey), entry];
        const text = indexText(result.kind === "stale-context" ? nonce() : current.epoch, entries, current.heads);
        const contextText =
          result.kind === "usable-recorded-context" ? `${canonicalContractData(result.contract.context)}\n` : "";
        const contractText = result.kind === "usable-recorded-context" ? serializeQueryContract(result.contract) : "";
        const before = await readUsage(),
          previousIndexBytes = await fileSize(path.index);
        const contextFile = join(path.contexts, `${contextHash}.json`);
        const contractFile =
          result.kind === "usable-recorded-context" ? join(path.queries, `${result.contract.digest}.json`) : "";
        const added =
          Math.max(0, Buffer.byteLength(text) - previousIndexBytes) +
          (contextText && !(await fileSize(contextFile)) ? Buffer.byteLength(contextText) : 0) +
          (contractText && !(await fileSize(contractFile)) ? Buffer.byteLength(contractText) : 0);
        const retiresKnownEvidence =
          result.kind !== "usable-recorded-context" && (previous !== undefined || result.kind === "stale-context");
        if (
          Buffer.byteLength(text) > maxObjectBytes ||
          Buffer.byteLength(contractText) > maxObjectBytes ||
          Buffer.byteLength(contextText) > maxObjectBytes
        ) {
          // Resource pressure cannot preserve a result that has just been disproved.
          if (retiresKnownEvidence)
            await writeRetirementIndex(
              current,
              {
                requestKey: queryContractDigest({ kind: "retired-context", contextHash }),
                contextHash,
                revision: nonce(),
                recordedAt,
                result: { kind: "stale-context", code: "context-changed" },
              },
              assertLock,
              current.heads?.map((head) =>
                head.contextHash === contextHash ? { ...head, status: "stale", revision: nonce() } : head,
              ),
            );
          return { status: "capacity" as const };
        }
        if (!retiresKnownEvidence && before + added > maxBytes) return { status: "capacity" as const };
        // Reserve before object publication. Interrupted writes can overcount, never undercount.
        if (added) await writeUsage(before + added, assertLock);
        if (result.kind === "usable-recorded-context") {
          await write(join(path.contexts, `${contextHash}.json`), contextText, true, assertLock);
          await write(join(path.queries, `${result.contract.digest}.json`), contractText, true, assertLock);
        }
        await write(path.index, text, false, assertLock);
        const released = Math.max(0, previousIndexBytes - Buffer.byteLength(text));
        if (released) await writeUsage(Math.max(0, before + added - released), assertLock);
        return { status: "published" as const, revision };
      });
    },
    async invalidate() {
      await withLock(async (assertLock) => {
        await layout();
        await readIndex();
        await writeIndex(nonce(), [], assertLock);
      });
    },
    async retireContext(input) {
      const context = parseQueryContractContext(input),
        contextHash = queryContractDigest(context);
      await withLock(async (assertLock) => {
        await layout();
        const current = await readIndex();
        const entry: Entry = {
          requestKey: queryContractDigest({ kind: "retired-context", contextHash }),
          revision: nonce(),
          contextHash,
          recordedAt: now(),
          result: { kind: "stale-context", code: "context-changed" },
        };
        await writeRetirementIndex(
          current,
          entry,
          assertLock,
          current.heads?.map((head) =>
            head.contextHash === contextHash ? { ...head, status: "stale", revision: nonce() } : head,
          ),
        );
      });
    },
    async prune(pruneOptions = {}) {
      const retentionMs = pruneOptions.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
      if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
        throw new RangeError("Invalid analysis cache retention");
      return withLock(async (assertLock) => {
        await layout();
        const protectedQueries = new Set<string>(),
          protectedCatalogs = new Set<string>(),
          protectedContexts = new Set<string>();
        for (const name of await names(path.indexes)) {
          if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
          const current = index(
            JSON.parse(await readCacheFile(join(path.indexes, name), maxObjectBytes)),
            name.slice(0, -5),
            65_535,
          );
          for (const entry of current.entries)
            if (entry.result.kind === "usable-recorded-context") {
              protectedQueries.add(entry.result.contractDigest);
              protectedContexts.add(entry.contextHash);
            } else if (entry.result.kind === "project-catalog") protectedCatalogs.add(entry.result.catalogDigest);
          for (const head of current.heads ?? []) protectedContexts.add(head.contextHash);
        }
        const files = await objects();
        let retainedBytes = files.reduce((sum, file) => sum + file.bytes, 0),
          removed = 0,
          bytes = 0;
        const observedAt = now(),
          cutoff = retentionMs === 0 ? Number.POSITIVE_INFINITY : observedAt - retentionMs;
        for (const file of files.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path))) {
          if (
            file.kind === "index" ||
            (file.kind === "query" && protectedQueries.has(file.digest)) ||
            (file.kind === "catalog" && protectedCatalogs.has(file.digest)) ||
            (file.kind === "context" && protectedContexts.has(file.digest)) ||
            (file.modified > cutoff && retainedBytes <= maxBytes)
          )
            continue;
          await assertLock();
          await unlink(file.path);
          removed++;
          bytes += file.bytes;
          retainedBytes -= file.bytes;
        }
        await writeUsage(retainedBytes, assertLock);
        return Object.freeze({ removed, bytes, retainedBytes });
      });
    },
  } satisfies AnalysisCache);
}

function recordedQuery(request: LiveAnalysisRequest): RecordedAnalysisQuery {
  return Object.freeze({
    connectionContext: request.connectionContext,
    adapter: request.adapter,
    candidate: request.candidate,
    context: request.staticClaim.context,
    policy: request.policy,
  });
}
