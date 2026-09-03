export const SUPPORT_BUNDLE_FORMAT_VERSION = 1 as const;

export interface DebugRedactionOptions {
  readonly includeSql?: boolean;
  readonly includeIdentifiers?: boolean;
  readonly includePaths?: boolean;
  readonly includeDebugText?: boolean;
}

export interface DebugEventInput {
  readonly phase: string;
  readonly event: string;
  readonly durationMilliseconds?: number;
  readonly cache?: Readonly<Record<string, number>>;
  readonly capability?: string;
  readonly failure?: { readonly code: string; readonly classification: string };
  readonly context?: unknown;
}

export interface DebugEvent extends Omit<DebugEventInput, "context"> {
  readonly context?: unknown;
}

export interface SupportBundle {
  readonly formatVersion: typeof SUPPORT_BUNDLE_FORMAT_VERSION;
  readonly redaction: "default";
  readonly inventory: {
    readonly eventCount: number;
    readonly phases: readonly string[];
    readonly events: readonly string[];
    readonly contextIncluded: boolean;
  };
  readonly environment: unknown;
  readonly events: readonly DebugEvent[];
}

const sensitiveKey =
  /(?:authorization|cookie|credential|password|secret|token|connection|string|dsn|parameter|params|values?)/iu;
const sqlKey = /(?:sql|query|source|statement|text)/iu;
const identifierKey = /(?:identifier|table|column|schema|relation|namespace)/iu;
const pathKey = /(?:file|path|cwd|root|uri|directory)/iu;
const safeTextKey =
  /^(?:backend|capability|category|classification|code|event|kind|operation|phase|releaseTrack|status|support|version)$/u;

function redact(
  value: unknown,
  options: DebugRedactionOptions,
  key: string,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 8) return "[redacted:depth-limit]";
  if (sensitiveKey.test(key)) return "[redacted:sensitive]";
  if (sqlKey.test(key) && options.includeSql !== true) return "[redacted:sql]";
  if (identifierKey.test(key) && options.includeIdentifiers !== true) return "[redacted:identifier]";
  if (pathKey.test(key) && options.includePaths !== true) return "[redacted:path]";
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return typeof value === "number" && !Number.isFinite(value) ? "[redacted:non-json-number]" : value;
  if (typeof value === "string")
    return options.includeDebugText === true || safeTextKey.test(key) ? value : "[redacted:text]";
  if (typeof value !== "object") return `[redacted:${typeof value}]`;
  if (seen.has(value)) return "[redacted:cycle]";
  seen.add(value);
  if (Array.isArray(value))
    return Object.freeze(value.slice(0, 256).map((item) => redact(item, options, key, seen, depth + 1)));
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 256)
    .map(([name, item]) => [name, redact(item, options, name, seen, depth + 1)] as const);
  return Object.freeze(Object.fromEntries(entries));
}

export function redactDebugContext(value: unknown, options: DebugRedactionOptions = {}): unknown {
  return redact(value, options, "context", new WeakSet(), 0);
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

export function createDebugEvent(input: DebugEventInput, options: DebugRedactionOptions = {}): DebugEvent {
  const phase = requiredText(input.phase, "Debug event phase");
  const event = requiredText(input.event, "Debug event name");
  if (
    input.durationMilliseconds !== undefined &&
    (!Number.isFinite(input.durationMilliseconds) || input.durationMilliseconds < 0)
  ) {
    throw new TypeError("Debug event durationMilliseconds must be a non-negative finite number");
  }
  return Object.freeze({
    phase,
    event,
    ...(input.durationMilliseconds === undefined ? {} : { durationMilliseconds: input.durationMilliseconds }),
    ...(input.cache === undefined
      ? {}
      : { cache: redactDebugContext(input.cache) as Readonly<Record<string, number>> }),
    ...(input.capability === undefined ? {} : { capability: requiredText(input.capability, "Debug event capability") }),
    ...(input.failure === undefined
      ? {}
      : {
          failure: Object.freeze({
            code: requiredText(input.failure.code, "Debug event failure code"),
            classification: requiredText(input.failure.classification, "Debug event failure classification"),
          }),
        }),
    ...(input.context === undefined ? {} : { context: redactDebugContext(input.context, options) }),
  });
}

export function createSupportBundle(events: readonly DebugEventInput[], environment: unknown = {}): SupportBundle {
  const redactedEvents = Object.freeze(events.map((event) => createDebugEvent(event)));
  return Object.freeze({
    formatVersion: SUPPORT_BUNDLE_FORMAT_VERSION,
    redaction: "default",
    inventory: Object.freeze({
      eventCount: redactedEvents.length,
      phases: Object.freeze([...new Set(redactedEvents.map(({ phase }) => phase))].sort()),
      events: Object.freeze([...new Set(redactedEvents.map(({ event }) => event))].sort()),
      contextIncluded: redactedEvents.some(({ context }) => context !== undefined),
    }),
    environment: redactDebugContext(environment),
    events: redactedEvents,
  });
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
