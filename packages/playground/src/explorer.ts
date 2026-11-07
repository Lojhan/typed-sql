import type { SchemaSnapshot, SqlRenderer } from "@typed-sql/core";
import {
  type CatalogEvidence,
  digest,
  type JsonValue,
  type MigrationAttempt,
  type MigrationHistory,
  parseHistory,
} from "@typed-sql/migrations";
import { calculateSchemaHash, parseSchemaSnapshot } from "@typed-sql/schema";
import type { PlaygroundTarget } from "./contracts.js";
import type {
  ExplorerEvent,
  ExplorerLink,
  ExplorerMigration,
  ExplorerObject,
  ExplorerResponse,
  PlaygroundCatalogObject,
  PlaygroundMigrationObservation,
} from "./explorer-types.js";
import { type ExplorerLocalMigration, explorerMigrationInventory } from "./migration-inventory.js";

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === "extension" ? undefined : item))) as JsonValue;
const id = (kind: string, namespace: string, name: string, parent?: string): string =>
  JSON.stringify([kind, namespace, parent ?? null, name]);
const refId = (ref: PlaygroundCatalogObject): string => id(ref.kind, ref.namespace, ref.name, ref.parentName);
const sorted = <T extends { id: string }>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
type MutableObject = Omit<ExplorerObject, "history" | "historyState" | "historyMessage"> & {
  history: ExplorerEvent[];
  historyState: ExplorerObject["historyState"];
  historyMessage?: string;
};

function schemaObjects(input: SchemaSnapshot): {
  coverage: "structural" | "legacy";
  objects: Map<string, MutableObject>;
  links: ExplorerLink[];
} {
  const snapshot = parseSchemaSnapshot(input);
  const objects = new Map<string, MutableObject>();
  const links: ExplorerLink[] = [];
  const add = (
    identity: string,
    kind: string,
    namespace: string,
    name: string,
    details: unknown,
    parentId?: string,
  ) => {
    objects.set(identity, {
      id: identity,
      kind,
      namespace,
      name,
      details: json({ exists: true, ...(details as object) }),
      ...(parentId === undefined ? {} : { parentId }),
      history: [],
      historyState: "unavailable",
    });
    if (parentId !== undefined)
      links.push({
        id: JSON.stringify(["contains", parentId, identity]),
        source: parentId,
        target: identity,
        kind: "contains",
      });
  };
  const namespace = (name: string) => {
    const identity = id("namespace", name, name);
    if (!objects.has(identity)) add(identity, "namespace", name, name, { kind: "schema" });
    return identity;
  };
  if (snapshot.formatVersion !== 2) {
    for (const [key, relation] of Object.entries(snapshot.tables)) {
      const ns = relation.schema ?? "";
      const name = relation.name ?? key;
      const relationId = id("relation", ns, name);
      add(
        relationId,
        "table",
        ns,
        name,
        { identity: key, coverage: "legacy", columns: Object.keys(relation.columns) },
        namespace(ns),
      );
      for (const [key, column] of Object.entries(relation.columns))
        add(id("column", ns, key, name), "column", ns, key, column, relationId);
    }
    // V1 enum keys are opaque; do not guess namespace boundaries by splitting dotted identifiers.
    for (const [name, labels] of Object.entries(snapshot.enums ?? {}))
      add(id("legacy-enum", "", name), "enum", "", name, { labels, coverage: "legacy" }, namespace(""));
    return { coverage: "legacy", objects, links };
  }
  for (const ns of Object.values(snapshot.namespaces))
    add(id("namespace", ns.name, ns.name), "namespace", ns.name, ns.name, ns);
  const relationIds = new Map(
    Object.entries(snapshot.relations).map(([key, r]) => [key, id("relation", r.schema ?? "", r.name)]),
  );
  const typeIds = new Map<string, string>();
  for (const [key, type] of Object.entries(snapshot.types)) {
    const ns = type.schema ?? "";
    const identity = id("type", ns, type.name);
    typeIds.set(type.identity, identity);
    add(
      identity,
      type.kind === "enum" ? "enum" : type.kind === "domain" ? "domain" : "type",
      ns,
      type.name,
      { snapshotKey: key, ...type },
      namespace(ns),
    );
  }
  for (const [key, relation] of Object.entries(snapshot.relations)) {
    const ns = relation.schema ?? "";
    const relationId = relationIds.get(key)!;
    add(
      relationId,
      relation.kind,
      ns,
      relation.name,
      {
        identity: key,
        kind: relation.kind,
        columns: Object.keys(relation.columns),
        constraints: relation.constraints,
        indexes: relation.indexes,
      },
      namespace(ns),
    );
    for (const column of Object.values(relation.columns)) {
      const columnId = id("column", ns, column.name, relation.name);
      add(columnId, "column", ns, column.name, column, relationId);
      const target = typeIds.get(column.typeIdentity);
      if (target)
        links.push({ id: JSON.stringify(["type", columnId, target]), source: columnId, target, kind: "type" });
    }
    for (const index of relation.indexes) {
      const indexId = id("index", ns, index.name, relation.name);
      add(indexId, "index", ns, index.name, index, relationId);
      for (const column of index.columns)
        if (column.column)
          links.push({
            id: JSON.stringify(["index-column", indexId, column.column]),
            source: indexId,
            target: id("column", ns, column.column, relation.name),
            kind: "index-column",
          });
    }
    for (const constraint of relation.constraints) {
      const name = constraint.name ?? constraint.identity;
      const constraintId = id("constraint", ns, name, relation.name);
      add(constraintId, "constraint", ns, name, constraint, relationId);
      if (constraint.kind === "foreign-key") {
        const relationshipId = id("relationship", ns, name, relation.name);
        const target = relationIds.get(constraint.referencedRelation);
        add(
          relationshipId,
          "relationship",
          ns,
          name,
          { ...constraint, constraintId, referenceState: target ? "captured" : "outside-snapshot" },
          relationId,
        );
        if (target) links.push({ id: relationshipId, source: relationId, target, kind: "foreign-key", label: name });
      }
    }
  }
  for (const overloads of Object.values(snapshot.routines))
    for (const routine of overloads)
      add(
        id("routine", routine.schema ?? "", routine.identity),
        "routine",
        routine.schema ?? "",
        routine.name,
        routine,
        namespace(routine.schema ?? ""),
      );
  return { coverage: "structural", objects, links };
}
function catalogDetail(catalog: CatalogEvidence | undefined, key: string): JsonValue | undefined {
  if (!catalog || !(key in catalog.objects)) return undefined;
  const details = (catalog as CatalogEvidence & { details?: Readonly<Record<string, JsonValue>> }).details;
  const fingerprint = catalog.objects[key];
  const definitionHash =
    fingerprint !== null && typeof fingerprint === "object" && !Array.isArray(fingerprint)
      ? (fingerprint as Readonly<Record<string, JsonValue>>).definitionHash
      : undefined;
  return (
    details?.[key] ??
    (typeof definitionHash === "string" && /^[a-f0-9]{64}$/u.test(definitionHash)
      ? { definitionHash }
      : { fingerprint: digest(fingerprint) })
  );
}
function hasDetails(catalog: CatalogEvidence | undefined, key: string): boolean {
  return (
    catalog !== undefined &&
    (catalog as CatalogEvidence & { details?: Readonly<Record<string, JsonValue>> }).details?.[key] !== undefined
  );
}
function comparable(before: CatalogEvidence | undefined, after: CatalogEvidence | undefined): boolean {
  return (
    before?.coverage === "complete" &&
    after?.coverage === "complete" &&
    before.dialect === after.dialect &&
    before.serverMajor === after.serverMajor &&
    digest(before.namespaces) === digest(after.namespaces)
  );
}
function eventBase(attempt: MigrationAttempt, history: MigrationHistory): Omit<ExplorerEvent, "change" | "evidence"> {
  const applied = history.applied.find((item) => item.attemptId === attempt.id);
  return {
    migrationId: attempt.migrationId,
    attemptId: attempt.id,
    direction: attempt.direction,
    origin:
      applied?.origin ??
      (attempt.state === "resolved"
        ? "resolved"
        : attempt.state === "applied" && attempt.direction === "down"
          ? "executed"
          : "unknown"),
    state: attempt.state,
    ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
    ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
  };
}
export interface ExplorerBuildOptions {
  readonly schema: SchemaSnapshot;
  readonly source: string;
  readonly capturedAt: string;
  readonly directory?: string;
  readonly local: readonly ExplorerLocalMigration[];
  readonly observation?: PlaygroundMigrationObservation;
  readonly state: ExplorerResponse["migrations"]["state"];
  readonly message?: string;
}
/** Reduces only persisted evidence. Current SQL files never manufacture historical object changes. */
export function buildExplorer(options: ExplorerBuildOptions): ExplorerResponse {
  const { objects, links, coverage } = schemaObjects(options.schema);
  const observation = options.observation;
  const history = observation?.history;
  const attempts = new Map<string, ExplorerEvent[]>();
  let gaps = options.state !== "ready";
  const allEvents: ExplorerEvent[] = [];
  if (history) {
    const refs = new Map(observation.objects.map((ref) => [ref.key, ref]));
    const committed = history.attempts.filter(
      (attempt) =>
        attempt.state === "applied" || (attempt.state === "resolved" && attempt.resolution === "confirm-applied"),
    );
    const latest = committed.at(-1);
    const head =
      latest === undefined
        ? undefined
        : (history.applied.find((item) => item.attemptId === latest.id)?.catalog ?? latest.expectedCatalog);
    const unsettled = history.attempts.some((attempt) => ["running", "unknown"].includes(attempt.state));
    const lastDetail = new Map<string, JsonValue>();
    for (const attempt of history.attempts)
      for (const catalog of [attempt.beforeCatalog, attempt.expectedCatalog])
        for (const key of Object.keys(catalog?.objects ?? {})) {
          const value = catalogDetail(catalog, key);
          if (value !== undefined) lastDetail.set(key, value);
        }
    for (const ref of refs.values()) {
      const identity = refId(ref);
      if (objects.has(identity)) continue;
      const namespaceId = id("namespace", ref.namespace, ref.namespace);
      if (!objects.has(namespaceId))
        objects.set(namespaceId, {
          id: namespaceId,
          kind: "namespace",
          namespace: ref.namespace,
          name: ref.namespace,
          details: { exists: "unknown", historyOnly: true },
          history: [],
          historyState: "unknown",
        });
      const parentId =
        ref.parentName === undefined
          ? ref.kind === "namespace"
            ? undefined
            : namespaceId
          : id("relation", ref.namespace, ref.parentName);
      const exists =
        head?.coverage === "complete" &&
        head.namespaces.includes(ref.namespace) &&
        !unsettled &&
        !(ref.key in head.objects)
          ? false
          : "unknown";
      objects.set(identity, {
        id: identity,
        kind: ref.kind,
        namespace: ref.namespace,
        name: ref.name,
        ...(parentId === undefined ? {} : { parentId }),
        details: {
          exists,
          historyOnly: true,
          catalogKey: ref.key,
          ...(lastDetail.has(ref.key) ? { lastCaptured: lastDetail.get(ref.key)! } : {}),
        },
        history: [],
        historyState: "unknown",
      });
      if (parentId)
        links.push({
          id: JSON.stringify(["contains", parentId, identity]),
          source: parentId,
          target: identity,
          kind: "contains",
        });
    }
    for (const attempt of history.attempts) {
      const base = eventBase(attempt, history);
      const applied = history.applied.find((item) => item.attemptId === attempt.id);
      const confirmed =
        attempt.state === "applied" || (attempt.state === "resolved" && attempt.resolution === "confirm-applied");
      const before = attempt.beforeCatalog;
      const after = confirmed ? (applied?.catalog ?? attempt.expectedCatalog) : undefined;
      const complete = comparable(before, after);
      if (!complete) gaps = true;
      const keys = new Set([
        ...Object.keys(before?.objects ?? {}),
        ...Object.keys((after ?? attempt.expectedCatalog)?.objects ?? {}),
      ]);
      const changes: ExplorerEvent[] = [];
      for (const key of keys) {
        const old = before?.objects[key];
        const presentationAfter = after ?? attempt.expectedCatalog;
        const next = presentationAfter?.objects[key];
        const change: ExplorerEvent["change"] = !complete
          ? "unknown"
          : old === undefined
            ? "added"
            : next === undefined
              ? "removed"
              : digest(old) !== digest(next)
                ? "changed"
                : "unchanged";
        if (change === "unchanged") continue;
        const reference = refs.get(key);
        const objectId = reference === undefined ? undefined : refId(reference);
        const detailed =
          (!before || old === undefined || hasDetails(before, key)) &&
          (!presentationAfter || next === undefined || hasDetails(presentationAfter, key));
        const event: ExplorerEvent = {
          ...base,
          change,
          evidence: applied?.catalog ? "captured" : attempt.expectedCatalog ? "expected" : "unknown",
          details: detailed ? "captured" : "fingerprint-only",
          catalogKey: key,
          ...(objectId === undefined ? {} : { objectId }),
          ...(old === undefined ? {} : { before: catalogDetail(before, key)! }),
          ...(next === undefined ? {} : { after: catalogDetail(presentationAfter, key)! }),
        };
        changes.push(event);
        allEvents.push(event);
      }
      const summary: ExplorerEvent = {
        ...base,
        change: complete ? (changes.length ? "changed" : "unchanged") : "unknown",
        evidence: applied?.catalog ? "captured" : attempt.expectedCatalog ? "expected" : "unknown",
        changes,
      };
      const list = attempts.get(attempt.migrationId) ?? [];
      list.push(summary);
      attempts.set(attempt.migrationId, list);
    }
    for (const event of allEvents) {
      let owner = event.objectId;
      const seen = new Set<string>();
      while (owner && !seen.has(owner)) {
        seen.add(owner);
        const object = objects.get(owner);
        if (!object) break;
        object.history.push(event);
        owner = object.parentId;
      }
    }
    for (const object of objects.values()) {
      if (
        object.kind === "relationship" &&
        object.details !== null &&
        typeof object.details === "object" &&
        !Array.isArray(object.details) &&
        typeof (object.details as Readonly<Record<string, JsonValue>>).constraintId === "string"
      )
        object.history.push(
          ...(objects.get((object.details as Readonly<Record<string, JsonValue>>).constraintId as string)?.history ??
            []),
        );
      const matchingIdentity =
        observation.objects.some((reference) => refId(reference) === object.id) ||
        (object.kind === "relationship" && object.history.length > 0);
      object.historyState = gaps || !matchingIdentity ? "unknown" : "captured";
      if (!matchingIdentity)
        object.historyMessage =
          "This snapshot object has no exact persisted catalog identity; history attribution is unavailable.";
      if (gaps)
        object.historyMessage =
          "Some persisted attempts lack complete before/after catalog evidence. Unrecorded changes cannot be attributed to a migration.";
    }
  }
  const locals = new Map(options.local.map((item) => [item.id, item]));
  const ids = new Set([
    ...locals.keys(),
    ...(history?.attempts.map((item) => item.migrationId) ?? []),
    ...(history?.applied.map((item) => item.id) ?? []),
  ]);
  const entries: ExplorerMigration[] = [];
  for (const migrationId of ids) {
    const local = locals.get(migrationId);
    const applied = history?.applied.find((item) => item.id === migrationId);
    const list = history?.attempts.filter((item) => item.migrationId === migrationId) ?? [];
    const last = list.at(-1);
    const hash = applied?.hash ?? last?.hash;
    const status: ExplorerMigration["status"] =
      local?.hash && hash && local.hash !== hash
        ? "diverged"
        : last && ["running", "unknown", "blocked"].includes(last.state)
          ? (last.state as "running" | "unknown" | "blocked")
          : applied
            ? "applied"
            : last?.state === "applied" && last.direction === "down"
              ? "reverted"
              : local?.hash
                ? options.state === "ready" && history !== undefined
                  ? "pending"
                  : "unverified"
                : last
                  ? "unknown"
                  : "unverified";
    entries.push({
      id: migrationId,
      status,
      files: local?.files ?? [],
      ...(local?.description === undefined ? {} : { description: local.description }),
      ...(hash === undefined ? {} : { hash }),
      ...(local?.hash === undefined ? {} : { localHash: local.hash }),
      ...(local?.message === undefined ? {} : { message: local.message }),
      attempts: attempts.get(migrationId) ?? [],
    });
  }
  return {
    schema: {
      schemaHash: calculateSchemaHash(options.schema),
      source: options.source,
      capturedAt: options.capturedAt,
      coverage,
      objects: sorted([...objects.values()]),
      links,
    },
    migrations: {
      state: options.state,
      ...(options.message === undefined ? {} : { message: options.message }),
      ...(options.directory === undefined ? {} : { directory: options.directory }),
      entries: sorted(entries),
    },
  };
}
export interface ExplorerServiceOptions {
  readonly root: string;
  readonly directory?: string;
  readonly renderer: SqlRenderer;
  readonly snapshot: () => { readonly schema: SchemaSnapshot; readonly source: string; readonly capturedAt: string };
}
export class ExplorerService {
  private observation: PlaygroundMigrationObservation | undefined;
  private refreshVersion = 0;
  private state: ExplorerResponse["migrations"]["state"] = "unavailable";
  private message = "Connect or refresh migration history to inspect persisted execution evidence.";
  constructor(private readonly options: ExplorerServiceOptions) {}
  async refresh(target: PlaygroundTarget, expectedDatabase?: string): Promise<void> {
    const version = ++this.refreshVersion;
    if (!target.migrationHistory) {
      this.observation = undefined;
      this.state = "unavailable";
      this.message = "The selected target adapter does not expose read-only persisted migration history.";
      return;
    }
    try {
      const observed = await target.migrationHistory();
      if (expectedDatabase !== undefined && observed.database !== expectedDatabase)
        throw new TypeError("Migration evidence belongs to another database");
      const history = parseHistory(observed.history);
      if (history.attempts.length > 5000 || history.applied.length > 2000 || observed.objects.length > 25_000)
        throw new TypeError("Migration observation exceeds its limits");
      if (version !== this.refreshVersion) return;
      this.observation = { ...observed, history };
      this.state = observed.state === "ready" ? "ready" : "unavailable";
      this.message =
        observed.state === "ready"
          ? "History comes from persisted migration attempts and captured catalogs; local files describe pending work only."
          : "No migration ledger exists in the configured history namespace. The explorer never creates it.";
    } catch {
      if (version !== this.refreshVersion) return;
      this.observation = undefined;
      this.state = "failed";
      this.message =
        "Migration history could not be observed safely. Check target identity, ledger permissions and configured history namespace.";
    }
  }
  async get(): Promise<ExplorerResponse> {
    const observation = this.observation;
    const snapshot = this.options.snapshot();
    let local: readonly ExplorerLocalMigration[] = [];
    let state = this.state;
    let message = this.message;
    if (this.options.directory === undefined) {
      if (observation === undefined) state = "unconfigured";
      message = "Configure migrations.directory to discover local pending migration files.";
    } else
      try {
        local = await explorerMigrationInventory(this.options.root, this.options.directory, this.options.renderer);
      } catch {
        message = "Migration inventory could not be read safely. Inspect its directory and file permissions.";
        if (state !== "ready") state = "failed";
      }
    return buildExplorer({
      ...snapshot,
      local,
      state,
      message,
      ...(this.options.directory === undefined ? {} : { directory: this.options.directory }),
      ...(observation === undefined ? {} : { observation }),
    });
  }
}
