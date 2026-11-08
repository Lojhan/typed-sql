import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readCacheFile } from "./cache-files.js";
import { canonicalContractData, queryContractDigest } from "./canonical.js";
import {
  type AnalysisContextScope,
  analysisContextScopeKey,
  assertContextScope,
  parseAnalysisContextScope,
} from "./context-scope.js";
import {
  createQueryContractIndex,
  parseQueryContract,
  parseQueryContractContext,
  type QueryContract,
  type QueryContractContext,
  serializeQueryContract,
} from "./contracts.js";

const MAX_BYTES = 8 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
export interface QueryContractSelection {
  readonly scope: AnalysisContextScope;
  readonly context: QueryContractContext;
}
/** Pure identity for a complete prospective export; no files are created. */
export function queryContractManifestDigest(
  inputs: readonly QueryContract[],
  options: { readonly selection?: QueryContractSelection } = {},
): string {
  return exportParts(inputs, options.selection).manifest.digest;
}
interface ContractManifest {
  readonly formatVersion: 1;
  readonly digest: string;
  readonly contexts: readonly string[];
  readonly queries: readonly string[];
  readonly selection?: { readonly scopeHash: string; readonly contextHash: string; readonly targetHash: string };
}
function parseManifest(input: unknown): ContractManifest {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      (Object.hasOwn(value, "selection")
        ? "contexts,digest,formatVersion,queries,selection"
        : "contexts,digest,formatVersion,queries") ||
    value.formatVersion !== 1 ||
    typeof value.digest !== "string" ||
    !digestPattern.test(value.digest)
  )
    throw new TypeError("Invalid query contract manifest");
  for (const key of ["contexts", "queries"]) {
    const items = value[key];
    if (
      !Array.isArray(items) ||
      items.some((item) => typeof item !== "string" || !digestPattern.test(item)) ||
      items.some((item, index) => index > 0 && item <= items[index - 1])
    )
      throw new TypeError("Contract manifest references must be sorted unique digests");
  }
  if (
    value.selection !== undefined &&
    (!value.selection ||
      typeof value.selection !== "object" ||
      Array.isArray(value.selection) ||
      Object.keys(value.selection).sort().join(",") !== "contextHash,scopeHash,targetHash" ||
      typeof value.selection.targetHash !== "string" ||
      !digestPattern.test(value.selection.targetHash) ||
      typeof value.selection.scopeHash !== "string" ||
      !digestPattern.test(value.selection.scopeHash) ||
      typeof value.selection.contextHash !== "string" ||
      !value.contexts.includes(value.selection.contextHash))
  )
    throw new TypeError("Invalid query contract context selection");
  const { digest, ...body } = value;
  if (queryContractDigest(body) !== digest) throw new TypeError("Query contract manifest digest differs");
  return value;
}
function exportParts(inputs: readonly QueryContract[], selected?: QueryContractSelection) {
  const contracts = inputs.map(parseQueryContract);
  createQueryContractIndex(contracts);
  const contexts = new Map(contracts.map((contract) => [queryContractDigest(contract.context), contract.context]));
  const queries = new Map(contracts.map((contract) => [contract.digest, contract]));
  let selection: ContractManifest["selection"];
  if (selected) {
    const scope = parseAnalysisContextScope(selected.scope),
      context = parseQueryContractContext(selected.context);
    assertContextScope(context, scope);
    const contextHash = queryContractDigest(context);
    if (contracts.some((contract) => queryContractDigest(contract.context) !== contextHash))
      throw new TypeError("Query contracts differ from the selected target context");
    contexts.set(contextHash, context);
    selection = { scopeHash: analysisContextScopeKey(scope), contextHash, targetHash: scope.connectionContext };
  }
  const body = {
    formatVersion: 1,
    contexts: [...contexts.keys()].sort(),
    queries: [...queries.keys()].sort(),
    ...(selection ? { selection } : {}),
  };
  return { contexts, queries, manifest: parseManifest({ ...body, digest: queryContractDigest(body) }) };
}
const readBounded = (path: string) => readCacheFile(path, MAX_BYTES, "Query contract artifact");
async function publish(
  path: string,
  data: string,
  immutable: boolean,
  beforePublish?: () => Promise<void>,
): Promise<void> {
  if (Buffer.byteLength(data) > MAX_BYTES) throw new TypeError("Query contract artifact exceeds byte limit");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await beforePublish?.();
    if (!immutable) await rename(temporary, path);
    else {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readBounded(path)) !== data) throw new TypeError("Conflicting immutable query contract artifact");
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Explicit durable export. The manifest is the atomic commit point; old objects are retained. */
export async function exportQueryContracts(
  directory: string,
  inputs: readonly QueryContract[],
  options: {
    /** null requires no existing manifest; an omitted value permits replacement. */
    readonly expectedManifestDigest?: string | null;
    /** Revalidate project inputs immediately before manifest publication. */
    readonly beforeCommit?: () => Promise<void>;
    readonly selection?: QueryContractSelection;
  } = {},
): Promise<string> {
  if (
    options.expectedManifestDigest !== undefined &&
    options.expectedManifestDigest !== null &&
    (typeof options.expectedManifestDigest !== "string" || !digestPattern.test(options.expectedManifestDigest))
  )
    throw new TypeError("Invalid expected query contract manifest digest");
  const { contexts, queries, manifest } = exportParts(inputs, options.selection);
  await mkdir(join(directory, "contexts"), { recursive: true });
  await mkdir(join(directory, "queries"), { recursive: true });
  const lockPath = join(directory, ".publication.lock");
  const existing = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new TypeError("Unsafe query contract publication lock");
  let compromised: Error | undefined;
  const { lock } = await import("proper-lockfile");
  const release = await lock(directory, {
    realpath: false,
    lockfilePath: lockPath,
    stale: 10_000,
    update: 2_000,
    retries: { retries: 8, minTimeout: 10, maxTimeout: 100, factor: 1.5, randomize: true },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    const leased = await lstat(lockPath);
    const guard = async () => {
      const current = await lstat(lockPath);
      if (
        compromised ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== leased.ino ||
        current.dev !== leased.dev
      )
        throw new Error("Query contract publication lease lost");
      if (options.expectedManifestDigest !== undefined) {
        const digest = await readQueryContractManifestDigest(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (digest !== options.expectedManifestDigest)
          throw new Error("Query contract manifest changed; retry generation");
      }
    };
    await guard();
    for (const [digest, context] of contexts)
      await publish(join(directory, "contexts", `${digest}.json`), `${canonicalContractData(context)}\n`, true);
    for (const [digest, contract] of queries)
      await publish(join(directory, "queries", `${digest}.json`), serializeQueryContract(contract), true);
    await publish(join(directory, "manifest.json"), `${canonicalContractData(manifest)}\n`, false, async () => {
      await options.beforeCommit?.();
      await guard();
    });
    return manifest.digest;
  } finally {
    await release();
  }
}

/** Exact manifest identity for guarded publication; this does not validate its referenced closure. */
export async function readQueryContractManifestDigest(directory: string): Promise<string> {
  return parseManifest(JSON.parse(await readBounded(join(directory, "manifest.json")))).digest;
}

/** Selects only the target/context binding declared by a durable manifest. No cache or native access. */
export async function loadQueryContractContext(
  directory: string,
  input: AnalysisContextScope,
): Promise<QueryContractContext | undefined> {
  const scope = parseAnalysisContextScope(input);
  const manifest = parseManifest(JSON.parse(await readBounded(join(directory, "manifest.json"))));
  if (!manifest.selection) return undefined;
  if (manifest.selection.targetHash !== scope.connectionContext)
    throw new TypeError("Durable contract manifest does not select the configured target scope");
  if (manifest.selection.scopeHash !== analysisContextScopeKey(scope)) return undefined;
  const context = parseQueryContractContext(
    JSON.parse(await readBounded(join(directory, "contexts", `${manifest.selection.contextHash}.json`))),
  );
  if (queryContractDigest(context) !== manifest.selection.contextHash)
    throw new TypeError("Durable selected context digest differs");
  assertContextScope(context, scope);
  return context;
}

/** Loads only the declared closure. Missing, corrupt or incompatible inputs never fall back to cache. */
export async function loadQueryContracts(directory: string): Promise<readonly QueryContract[]> {
  return (await loadQueryContractInputs(directory)).contracts;
}

/** One manifest read binds the validated closure, target selection and watcher dependencies. */
export async function loadQueryContractInputs(
  directory: string,
  input?: AnalysisContextScope,
): Promise<{
  readonly contracts: readonly QueryContract[];
  readonly manifestDigest: string;
  readonly files: readonly string[];
  readonly context?: QueryContractContext;
}> {
  const manifest = parseManifest(JSON.parse(await readBounded(join(directory, "manifest.json"))));
  const contexts = new Map<string, string>();
  for (const digest of manifest.contexts) {
    const context = parseQueryContractContext(
      JSON.parse(await readBounded(join(directory, "contexts", `${digest}.json`))),
    );
    if (queryContractDigest(context) !== digest) throw new TypeError("Query contract context digest differs");
    contexts.set(digest, canonicalContractData(context));
  }
  const contracts: QueryContract[] = [];
  const usedContexts = new Set<string>(manifest.selection ? [manifest.selection.contextHash] : []);
  for (const digest of manifest.queries) {
    const contract = parseQueryContract(JSON.parse(await readBounded(join(directory, "queries", `${digest}.json`))));
    if (contract.digest !== digest) throw new TypeError("Query contract object digest differs");
    const contextDigest = queryContractDigest(contract.context);
    if (
      (manifest.selection && contextDigest !== manifest.selection.contextHash) ||
      contexts.get(contextDigest) !== canonicalContractData(contract.context)
    )
      throw new TypeError("Query contract context is outside the declared closure");
    usedContexts.add(contextDigest);
    contracts.push(contract);
  }
  if (usedContexts.size !== contexts.size) throw new TypeError("Unused query contract context in closure");
  createQueryContractIndex(contracts);
  let context: QueryContractContext | undefined;
  if (input && manifest.selection) {
    const scope = parseAnalysisContextScope(input);
    if (manifest.selection.targetHash !== scope.connectionContext)
      throw new TypeError("Durable contract manifest does not select the configured target scope");
    if (manifest.selection.scopeHash === analysisContextScopeKey(scope)) {
      context = parseQueryContractContext(JSON.parse(contexts.get(manifest.selection.contextHash)!));
      assertContextScope(context, scope);
    }
  }
  return Object.freeze({
    contracts: Object.freeze(contracts),
    manifestDigest: manifest.digest,
    files: Object.freeze(
      [
        join(directory, "manifest.json"),
        ...manifest.contexts.map((digest) => join(directory, "contexts", `${digest}.json`)),
        ...manifest.queries.map((digest) => join(directory, "queries", `${digest}.json`)),
      ].sort(),
    ),
    ...(context ? { context } : {}),
  });
}
