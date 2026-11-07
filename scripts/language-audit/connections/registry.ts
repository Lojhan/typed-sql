import { createMapperRegistry } from "../../../tools/grammar-catalog/src/registry.mjs";
import { collectLive, hash } from "../inventory.mjs";
import type { AuditConnectionDefinition, AuditConnectionOptions, AuditConnectionOwner } from "./contracts.js";

export interface AuditConnectionRegistry {
  readonly ids: readonly string[];
  get(id: string): AuditConnectionOwner;
  extend(definitions: readonly AuditConnectionDefinition[]): AuditConnectionRegistry;
}
function expose(registry: ReturnType<typeof createMapperRegistry>): AuditConnectionRegistry {
  return Object.freeze({
    ids: registry.ids as readonly string[],
    get: (id: string): AuditConnectionOwner => registry.get(id) as AuditConnectionOwner,
    extend: (definitions: readonly AuditConnectionDefinition[]) => expose(registry.extend(definitions)),
  });
}

/** Adapter-specific metadata is acquired before capture provenance is attached. */
export async function collectAuditInventory(
  registry: AuditConnectionRegistry,
  id: string,
  connection: Awaited<ReturnType<typeof openAuditConnection>>,
  discovery?: ReturnType<typeof import("../discovery/registry.mjs").createDiscoveryRegistry>,
) {
  const capture = await collectLive(id, connection.query, connection.target, discovery);
  const identity = hash(capture.target);
  await registry.get(id).completeInventory?.(capture, connection);
  if (capture.dialect !== id || hash(capture.target) !== identity)
    throw new TypeError("Audit inventory adapter changed the captured engine identity");
  return capture;
}
export function createAuditConnectionRegistry(
  definitions: readonly AuditConnectionDefinition[],
): AuditConnectionRegistry {
  return expose(createMapperRegistry(definitions, { methods: ["connect"] }));
}

/** Driver selection belongs to registered owners; every caller requires an actual engine version. */
export async function openAuditConnection(
  registry: AuditConnectionRegistry,
  id: string,
  options: AuditConnectionOptions = {},
) {
  const connection = await registry.get(id).connect(options);
  if (typeof connection.target?.version !== "string" || !connection.target.version.trim()) {
    await connection.close();
    throw new TypeError(`Audit connection ${id} did not supply an actual engine version`);
  }
  return Object.freeze({
    ...connection,
    query: connection.query.bind(connection),
    prepare: connection.prepare.bind(connection),
    close: connection.close.bind(connection),
  });
}
