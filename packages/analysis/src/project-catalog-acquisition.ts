import type { NativeContractAdapter } from "./acquisition.js";
import { canonicalContractData } from "./canonical.js";
import { parseQueryContractContext, type QueryContractContext } from "./contracts.js";
import { type ProjectCatalog, parseProjectCatalog } from "./project-catalog.js";

export type NativeProjectCatalogAcquisition =
  | { readonly status: "acquired"; readonly catalog: ProjectCatalog }
  | { readonly status: "unavailable"; readonly reason: "unsupported-adapter" | "context-mismatch" | "context-changed" };

/** Explicit metadata acquisition; the adapter's guard covers collection and both context reads. */
export async function acquireNativeProjectCatalog(input: {
  readonly adapter: NativeContractAdapter;
  readonly sql: readonly string[];
  readonly context?: QueryContractContext;
  readonly signal?: AbortSignal;
}): Promise<NativeProjectCatalogAcquisition> {
  const { adapter, signal } = input;
  signal?.throwIfAborted();
  const sql = JSON.parse(canonicalContractData(input.sql));
  if (!Array.isArray(sql) || sql.length > 4096 || sql.some((value) => typeof value !== "string" || !value.length))
    throw new TypeError("Invalid project catalog query selection");
  Object.freeze(sql);
  const expected = input.context === undefined ? undefined : parseQueryContractContext(input.context);
  if (expected && canonicalContractData(expected.grammar) !== canonicalContractData(adapter.grammar))
    throw new TypeError("Project catalog adapter grammar differs");
  if (adapter.projectCatalogOwner === undefined) return { status: "unavailable", reason: "unsupported-adapter" };
  const owner = JSON.parse(canonicalContractData(adapter.projectCatalogOwner));
  if (
    !owner ||
    Array.isArray(owner) ||
    Object.keys(owner).sort().join(",") !== "id,version" ||
    Object.values(owner).some((value) => typeof value !== "string" || !value.length || value.length > 4096)
  )
    throw new TypeError("Invalid project catalog adapter owner");
  const session = await adapter.open(signal);
  const [operation] = await Promise.allSettled([
    (async (): Promise<NativeProjectCatalogAcquisition> => {
      signal?.throwIfAborted();
      if (!session.projectCatalog) return { status: "unavailable", reason: "unsupported-adapter" };
      const before = parseQueryContractContext(await session.context(signal));
      signal?.throwIfAborted();
      if (canonicalContractData(before.grammar) !== canonicalContractData(adapter.grammar))
        throw new TypeError("Project catalog session grammar differs");
      if (expected && canonicalContractData(before) !== canonicalContractData(expected))
        return { status: "unavailable", reason: "context-mismatch" };
      const catalog = parseProjectCatalog(await session.projectCatalog(sql, before, signal));
      signal?.throwIfAborted();
      if (
        canonicalContractData(catalog.owner) !== canonicalContractData(owner) ||
        canonicalContractData(catalog.context) !== canonicalContractData(before)
      )
        throw new TypeError("Project catalog evidence owner or context differs");
      const after = parseQueryContractContext(await session.context(signal));
      signal?.throwIfAborted();
      if (canonicalContractData(after) !== canonicalContractData(before))
        return { status: "unavailable", reason: "context-changed" };
      return { status: "acquired", catalog };
    })(),
  ]);
  const [cleanup] = await Promise.allSettled([Promise.resolve().then(() => session.close())]);
  if (operation.status === "rejected") {
    if (cleanup.status === "rejected")
      throw new AggregateError([operation.reason, cleanup.reason], "Project catalog acquisition and cleanup failed");
    throw operation.reason;
  }
  if (cleanup.status === "rejected") throw cleanup.reason;
  signal?.throwIfAborted();
  return operation.value;
}
