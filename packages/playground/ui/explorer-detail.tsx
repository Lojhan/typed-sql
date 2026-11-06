import { useId, useState } from "react";
import { evidenceText, type InspectionTarget, objectPresence, propertyChanges } from "./explorer-model";
import type { ExplorerCatalog, ExplorerEvent, ExplorerObject, ExplorerValue } from "./explorer-types";
import { Icon } from "./icon";

function Properties({ values }: { values: Record<string, string | undefined> }) {
  return (
    <dl className="inspection-properties">
      {Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
function displayEnvelope(value: ExplorerValue | undefined): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.formatVersion === 1 &&
    typeof value.kind === "string" &&
    value.properties !== null &&
    typeof value.properties === "object" &&
    !Array.isArray(value.properties)
  );
}
function EventChanges({
  event,
  onOpen,
  catalog,
}: {
  event: ExplorerEvent;
  onOpen: (target: InspectionTarget) => void;
  catalog: ExplorerCatalog;
}) {
  const changes =
    event.details === "captured"
      ? propertyChanges(event.before, event.after).filter(
          (change) =>
            !(displayEnvelope(event.before) || displayEnvelope(event.after)) ||
            (change.path !== "/formatVersion" && change.path !== "/kind"),
        )
      : [];
  const object = event.objectId ? catalog.schema.objects.find((object) => object.id === event.objectId) : undefined;
  return (
    <>
      {object ? (
        <button
          type="button"
          className="inspection-link"
          onClick={() => onOpen({ kind: "object", id: object.id, label: object.name })}
        >
          Inspect {object.name} <Icon name="schema" />
        </button>
      ) : null}
      {event.details !== "captured" ? (
        <p className="inspection-note">
          Detailed historical definition unavailable. Only the captured catalog fingerprints are available for this
          change.
        </p>
      ) : changes.length ? (
        <div className="property-diff-scroll">
          <table className="property-diff">
            <thead>
              <tr>
                <th>Property</th>
                <th>Before</th>
                <th>{event.evidence === "expected" ? "Expected after" : "After"}</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.path} className={`property-${change.change}`}>
                  <th scope="row">
                    <span>
                      {change.path
                        .replace(/^\/properties\//u, "")
                        .replace(/^\//u, "")
                        .split("/")
                        .map((part) =>
                          part
                            .replaceAll("~1", "/")
                            .replaceAll("~0", "~")
                            .replace(/([a-z])([A-Z])/gu, "$1 $2"),
                        )
                        .join(" › ")}
                    </span>
                    <small>{change.change}</small>
                  </th>
                  <td>
                    <code>{change.before === undefined ? "Not present" : evidenceText(change.before)}</code>
                  </td>
                  <td>
                    <code>{change.after === undefined ? "Not present" : evidenceText(change.after)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="inspection-note">No changed structural properties in this captured event.</p>
      )}
      <details className="raw-evidence">
        <summary>{event.details === "captured" ? "Captured definitions" : "Captured fingerprints"}</summary>
        <div className="history-comparison">
          <section>
            <h4>Before</h4>
            <pre>{evidenceText(event.before)}</pre>
          </section>
          <section>
            <h4>{event.evidence === "expected" ? "Expected after" : "After"}</h4>
            <pre>{evidenceText(event.after)}</pre>
          </section>
        </div>
      </details>
    </>
  );
}
function HistoryEntry({
  event,
  initialOpen,
  onOpen,
  catalog,
}: {
  event: ExplorerEvent;
  initialOpen: boolean;
  onOpen: (target: InspectionTarget) => void;
  catalog: ExplorerCatalog;
}) {
  const [expanded, setExpanded] = useState(initialOpen);
  return (
    <li>
      <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>
          <Icon name="history" />
          <span className="history-event-title">
            {event.migrationId}
            <small>{event.finishedAt ?? event.startedAt ?? "Time not captured"}</small>
          </span>
          <span className={`migration-status ${event.state}`}>{event.state}</span>
          <span className="history-change">{event.change}</span>
        </summary>
        {expanded ? (
          <div className="history-event-body">
            <Properties
              values={{
                Direction: event.direction,
                Origin: event.origin,
                Evidence: event.evidence,
                Attempt: event.attemptId,
                ...(event.catalogKey ? { "Catalog key": event.catalogKey } : {}),
              }}
            />
            {event.evidence === "expected" ? (
              <p className="inspection-note">
                Expected replay evidence. This is not a captured result from executing this attempt on the target.
              </p>
            ) : event.evidence === "unknown" ? (
              <p className="inspection-note">
                Execution outcome or before/after evidence is incomplete. A definition alone does not establish a
                database change.
              </p>
            ) : null}
            {event.origin !== "executed" ? (
              <p className="inspection-note">
                Recorded as {event.origin}. This entry does not establish that migration SQL executed on this target.
              </p>
            ) : null}
            <button
              type="button"
              className="inspection-link"
              onClick={() => onOpen({ kind: "migration", id: event.migrationId, label: event.migrationId })}
            >
              Inspect migration <Icon name="migration" />
            </button>
            {event.changes?.length ? (
              <div className="migration-object-changes">
                {event.changes.map((change) => (
                  <details key={change.catalogKey ?? change.objectId}>
                    <summary>
                      {catalog.schema.objects.find((object) => object.id === change.objectId)?.name ??
                        change.catalogKey ??
                        "Object"}
                      <span className="history-change">{change.change}</span>
                    </summary>
                    <div className="history-event-body">
                      <EventChanges event={change} onOpen={onOpen} catalog={catalog} />
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <EventChanges event={event} onOpen={onOpen} catalog={catalog} />
            )}
          </div>
        ) : null}
      </details>
    </li>
  );
}
function EventHistory({
  events,
  onOpen,
  empty,
  catalog,
}: {
  events: ExplorerEvent[];
  onOpen: (target: InspectionTarget) => void;
  empty: string;
  catalog: ExplorerCatalog;
}) {
  if (!events.length) return <p className="inspection-empty">{empty}</p>;
  return (
    <ol className="inspection-timeline">
      {events.toReversed().map((event, index) => (
        <HistoryEntry
          key={`${event.attemptId}:${event.objectId ?? event.catalogKey ?? ""}:${event.change}`}
          event={event}
          initialOpen={index === 0}
          onOpen={onOpen}
          catalog={catalog}
        />
      ))}
    </ol>
  );
}
export function ExplorerDetail({
  target,
  catalog,
  loading,
  error,
  onOpen,
  onOpenFile,
  files,
  onRefresh,
}: {
  target: InspectionTarget;
  catalog: ExplorerCatalog | null;
  loading: boolean;
  error: string;
  onOpen: (target: InspectionTarget) => void;
  onOpenFile: (file: string) => void;
  files: readonly string[];
  onRefresh: () => void;
}) {
  const [section, setSection] = useState<"definition" | "history">("definition");
  const sectionId = useId();
  const object =
    target.kind === "object" ? catalog?.schema.objects.find((object) => object.id === target.id) : undefined;
  const migration =
    target.kind === "migration"
      ? catalog?.migrations.entries.find((migration) => migration.id === target.id)
      : undefined;
  const parent = object?.parentId
    ? catalog?.schema.objects.find((candidate) => candidate.id === object.parentId)
    : undefined;
  const related = object
    ? (catalog?.schema.links
        .filter((link) => link.kind !== "contains" && (link.source === object.id || link.target === object.id))
        .map((link) => ({
          link,
          object: catalog.schema.objects.find(
            (candidate) => candidate.id === (link.source === object.id ? link.target : link.source),
          ),
        }))
        .filter((item): item is { link: typeof item.link; object: ExplorerObject } => !!item.object) ?? [])
    : [];
  const events = object?.history ?? migration?.attempts ?? [];
  const presence = objectPresence(object);
  const historical = presence === "removed";
  return (
    <section
      className="inspection-panel"
      aria-label={`${target.kind === "object" ? "Database object" : "Migration"} details`}
    >
      <div className="tool-toolbar inspection-toolbar">
        <span>
          {object
            ? `${object.namespace ? `${object.namespace} / ` : ""}${object.kind}`
            : migration
              ? "Migration"
              : "Inspection"}
        </span>
        <button type="button" disabled={loading} onClick={onRefresh}>
          <Icon name="refresh" />
          Refresh
        </button>
      </div>
      {error ? (
        <p role="alert" className="inspection-note">
          {error}
        </p>
      ) : null}
      {!object && !migration ? (
        <div className="inspection-empty">
          {loading
            ? "Loading captured evidence…"
            : "This item is not available in the current captured schema or migration inventory. Refresh the explorer to check again."}
        </div>
      ) : (
        <>
          <div className="inspection-title">
            <h2>{object?.name ?? migration?.id}</h2>
            {migration ? <span className={`migration-status ${migration.status}`}>{migration.status}</span> : null}
            {presence ? <span className="migration-status reverted">{historical ? "Removed" : "History"}</span> : null}
            {object && parent ? (
              <button
                type="button"
                className="inspection-link"
                onClick={() => onOpen({ kind: "object", id: parent.id, label: parent.name })}
              >
                {parent.name}
              </button>
            ) : null}
          </div>
          <div
            className="inspection-tabs"
            role="tablist"
            aria-label="Inspection sections"
            onKeyDown={(event) => {
              if (
                event.key !== "ArrowLeft" &&
                event.key !== "ArrowRight" &&
                event.key !== "Home" &&
                event.key !== "End"
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "definition"
                  : event.key === "End"
                    ? "history"
                    : section === "definition"
                      ? "history"
                      : "definition";
              setSection(next);
              event.currentTarget.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={section === "definition"}
              id={`${sectionId}-definition`}
              data-section="definition"
              aria-controls={`${sectionId}-panel`}
              tabIndex={section === "definition" ? 0 : -1}
              onClick={() => setSection("definition")}
            >
              {object ? "Definition" : "Overview"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={section === "history"}
              id={`${sectionId}-history`}
              data-section="history"
              aria-controls={`${sectionId}-panel`}
              tabIndex={section === "history" ? 0 : -1}
              onClick={() => setSection("history")}
            >
              History <span>{events.length}</span>
            </button>
          </div>
          <div
            className="inspection-content"
            id={`${sectionId}-panel`}
            aria-labelledby={`${sectionId}-${section}`}
            role="tabpanel"
            aria-label={section === "history" ? "History" : object ? "Definition" : "Overview"}
          >
            {section === "history" ? (
              <>
                {object?.historyMessage ? <p className="inspection-note">{object.historyMessage}</p> : null}
                {object && object.historyState !== "captured" ? (
                  <p className="inspection-note">
                    {object.historyState === "unavailable"
                      ? "Migration history is unavailable for this object."
                      : "The recorded history does not establish a complete sequence of changes for this object."}
                  </p>
                ) : null}
                {migration && catalog?.migrations.state !== "ready" ? (
                  <p className="inspection-note">
                    {catalog?.migrations.message ?? "Migration execution history is unavailable."}
                  </p>
                ) : null}
                <EventHistory
                  catalog={catalog!}
                  events={events}
                  onOpen={onOpen}
                  empty={
                    migration?.status === "pending"
                      ? "No recorded execution attempts. This migration is pending."
                      : "No captured execution evidence is available for this item."
                  }
                />
              </>
            ) : object ? (
              <>
                <Properties
                  values={{
                    Kind: object.kind,
                    Namespace: object.namespace || "Not specified",
                    Source: catalog?.schema.source,
                    "Captured at": catalog?.schema.capturedAt,
                    "Schema hash": catalog?.schema.schemaHash,
                    Coverage: catalog?.schema.coverage,
                  }}
                />
                {historical ? (
                  <p className="inspection-note">
                    This object is absent from the current captured schema. History retains its recorded migration
                    evidence.
                  </p>
                ) : null}
                {presence === "history" ? (
                  <p className="inspection-note">
                    This item is known from historical evidence. Its current existence is unknown in the captured
                    schema.
                  </p>
                ) : null}
                <h3>Captured definition</h3>
                <pre className="inspection-definition">{evidenceText(object.details)}</pre>
                {related.length ? (
                  <>
                    <h3>Related objects</h3>
                    <ul className="inspection-related">
                      {related.map(({ link, object }) => (
                        <li key={link.id}>
                          <button
                            type="button"
                            onClick={() => onOpen({ kind: "object", id: object.id, label: object.name })}
                          >
                            <Icon name="relationship" />
                            <span>{object.name}</span>
                            <small>{link.label ?? link.kind}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : migration ? (
              <>
                {migration.description ? <p>{migration.description}</p> : null}
                <Properties
                  values={{
                    Status: migration.status,
                    Directory: catalog?.migrations.directory,
                    "Recorded definition hash": migration.hash,
                    "Local definition hash": migration.localHash,
                    "Recorded attempts": String(migration.attempts.length),
                  }}
                />
                {migration.message ? <p className="inspection-note">{migration.message}</p> : null}
                {migration.status === "pending" ? (
                  <p className="inspection-note">
                    Present in the migration inventory with no recorded application to this target.
                  </p>
                ) : null}
                {migration.status === "unverified" ? (
                  <p className="inspection-note">
                    Definition identity is unverified. Migration modules are not executed merely to list or inspect
                    files.
                  </p>
                ) : null}
                {migration.status === "diverged" ? (
                  <p className="inspection-note">
                    The local definition differs from the immutable recorded migration. Review the captured history
                    before making changes.
                  </p>
                ) : null}
                {catalog?.migrations.message ? <p className="inspection-note">{catalog.migrations.message}</p> : null}
                <h3>Definition files</h3>
                {migration.files.length ? (
                  <ul className="inspection-files">
                    {migration.files.map((file) => (
                      <li key={file}>
                        {files.includes(file) ? (
                          <button type="button" className="inspection-link" onClick={() => onOpenFile(file)}>
                            {file}
                          </button>
                        ) : (
                          <code>{file}</code>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="inspection-empty">No local definition file was found.</p>
                )}
                <p className="inspection-note">
                  History shows persisted attempt evidence. Files show the current local definition.
                </p>
              </>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
