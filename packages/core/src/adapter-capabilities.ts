const adapterCapabilityBrand: unique symbol = Symbol("@typed-sql/core.adapter-capability") as never;

/** A namespaced token describing one optional service exposed by a database adapter. */
export interface AdapterCapability<Service> {
  readonly id: string;
  readonly key: symbol;
  readonly [adapterCapabilityBrand]: () => Service;
}

export type AdapterCapabilityService<Capability> =
  Capability extends AdapterCapability<infer Service> ? Service : never;

export type AdapterCapabilityResolver = (key: symbol) => unknown;

export const adapterCapabilities: unique symbol = Symbol.for("@typed-sql/core.adapter-capabilities") as never;

/** Structural host contract implemented by adapters that provide optional services. */
export interface AdapterCapabilityHost {
  readonly [adapterCapabilities]?: AdapterCapabilityResolver;
}

export class UnsupportedAdapterCapabilityError extends Error {
  readonly code = "TSQL_UNSUPPORTED_ADAPTER_CAPABILITY";
  readonly capability: string;

  constructor(capability: string) {
    super(`This database adapter does not provide the ${capability} capability`);
    this.name = "UnsupportedAdapterCapabilityError";
    this.capability = capability;
  }
}

/** Defines a globally stable, namespaced adapter capability token. */
export function defineAdapterCapability<Service>(id: string): AdapterCapability<Service> {
  if (id.length === 0 || !id.includes(".")) {
    throw new TypeError("Adapter capability ids must be non-empty and namespaced, for example vendor.feature");
  }
  return Object.freeze({
    id,
    key: Symbol.for(`@typed-sql/adapter-capability/${id}`),
    [adapterCapabilityBrand]: (): Service => {
      throw new TypeError("Adapter capability type brands are not callable");
    },
  });
}

/** Creates the immutable resolver installed on one adapter or transaction scope. */
export function createAdapterCapabilityResolver(
  entries: readonly (readonly [AdapterCapability<unknown>, unknown])[],
): AdapterCapabilityResolver {
  const services = new Map<symbol, unknown>();
  for (const [capability, service] of entries) {
    if (services.has(capability.key)) throw new TypeError(`Duplicate adapter capability: ${capability.id}`);
    services.set(capability.key, service);
  }
  return (key: symbol): unknown => services.get(key);
}

/** Returns an optional adapter service without importing its driver or protocol package. */
export function getAdapterCapability<Service>(
  host: unknown,
  capability: AdapterCapability<Service>,
): Service | undefined {
  if ((typeof host !== "object" && typeof host !== "function") || host === null) return undefined;
  const resolver = (host as AdapterCapabilityHost)[adapterCapabilities];
  return resolver?.(capability.key) as Service | undefined;
}

export function hasAdapterCapability<Service>(host: unknown, capability: AdapterCapability<Service>): boolean {
  return getAdapterCapability(host, capability) !== undefined;
}

/** Resolves an adapter service or throws a stable fail-closed error. */
export function requireAdapterCapability<Service>(host: unknown, capability: AdapterCapability<Service>): Service {
  const service = getAdapterCapability(host, capability);
  if (service === undefined) throw new UnsupportedAdapterCapabilityError(capability.id);
  return service;
}
