import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalContractData, queryContractDigest } from "./canonical.js";
import {
  createQueryContractIndex,
  parseQueryContract,
  parseQueryContractContext,
  type QueryContract,
  serializeQueryContract,
} from "./contracts.js";

const MAX_BYTES = 8 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
interface ContractManifest {
  readonly formatVersion: 1;
  readonly digest: string;
  readonly contexts: readonly string[];
  readonly queries: readonly string[];
}
function parseManifest(input: unknown): ContractManifest {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "contexts,digest,formatVersion,queries" ||
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
  const { digest, ...body } = value;
  if (queryContractDigest(body) !== digest) throw new TypeError("Query contract manifest digest differs");
  return value;
}
async function readBounded(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new TypeError("Query contract artifact exceeds byte limit");
    return buffer.toString("utf8", 0, length);
  } finally {
    await file.close();
  }
}
async function publish(path: string, data: string, immutable: boolean): Promise<void> {
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
export async function exportQueryContracts(directory: string, inputs: readonly QueryContract[]): Promise<string> {
  const contracts = inputs.map(parseQueryContract);
  createQueryContractIndex(contracts);
  const contexts = new Map(contracts.map((contract) => [queryContractDigest(contract.context), contract.context]));
  const queries = new Map(contracts.map((contract) => [contract.digest, contract]));
  const body = { formatVersion: 1, contexts: [...contexts.keys()].sort(), queries: [...queries.keys()].sort() };
  const manifest = parseManifest({ ...body, digest: queryContractDigest(body) });
  await mkdir(join(directory, "contexts"), { recursive: true });
  await mkdir(join(directory, "queries"), { recursive: true });
  for (const [digest, context] of contexts)
    await publish(join(directory, "contexts", `${digest}.json`), `${canonicalContractData(context)}\n`, true);
  for (const [digest, contract] of queries)
    await publish(join(directory, "queries", `${digest}.json`), serializeQueryContract(contract), true);
  await publish(join(directory, "manifest.json"), `${canonicalContractData(manifest)}\n`, false);
  return manifest.digest;
}

/** Loads only the declared closure. Missing, corrupt or incompatible inputs never fall back to cache. */
export async function loadQueryContracts(directory: string): Promise<readonly QueryContract[]> {
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
  const usedContexts = new Set<string>();
  for (const digest of manifest.queries) {
    const contract = parseQueryContract(JSON.parse(await readBounded(join(directory, "queries", `${digest}.json`))));
    if (contract.digest !== digest) throw new TypeError("Query contract object digest differs");
    const contextDigest = queryContractDigest(contract.context);
    if (contexts.get(contextDigest) !== canonicalContractData(contract.context))
      throw new TypeError("Query contract context is outside the declared closure");
    usedContexts.add(contextDigest);
    contracts.push(contract);
  }
  if (usedContexts.size !== contexts.size) throw new TypeError("Unused query contract context in closure");
  createQueryContractIndex(contracts);
  return Object.freeze(contracts);
}
