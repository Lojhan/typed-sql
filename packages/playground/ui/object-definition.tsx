import type { ReactNode } from "react";
import { Button } from "./components";
import { evidenceText, type InspectionTarget, objectLabel, objectPresence } from "./explorer-model";
import type { ExplorerCatalog, ExplorerObject, ExplorerValue } from "./explorer-types";
import { Icon } from "./icon";
import {
  type CapturedRelationship,
  capturedFields,
  capturedNames,
  capturedNullability,
  capturedRelationship,
  columnKeys,
  indexColumns,
  isRelation,
  objectChildren,
  relationDefinition,
} from "./object-definition-model";

type Open = (target: InspectionTarget) => void;
function ObjectLink({
  object,
  onOpen,
  qualified = false,
}: {
  object: ExplorerObject;
  onOpen: Open;
  qualified?: boolean;
}) {
  return (
    <Button
      variant="link"
      className="definition-link"
      onClick={() => onOpen({ kind: "object", id: object.id, label: objectLabel(object) })}
    >
      {qualified && object.namespace ? `${object.namespace}.` : ""}
      {objectLabel(object)}
    </Button>
  );
}
function CellValue({ value }: { value: ExplorerValue | undefined }) {
  return (
    <>
      {value === undefined
        ? "Not captured"
        : typeof value === "string"
          ? value
          : typeof value === "boolean"
            ? value
              ? "Yes"
              : "No"
            : value === null
              ? "None"
              : evidenceText(value)}
    </>
  );
}
function Facts({ fields }: { fields: Record<string, ExplorerValue | undefined> }) {
  return (
    <dl className="definition-facts">
      {Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <CellValue value={value} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
function Section({ title, count, children }: { title: string; count?: number | undefined; children: ReactNode }) {
  return (
    <section className="definition-section" aria-label={title}>
      <h3>
        {title}
        {count !== undefined ? <span>{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}
function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Native overflow regions need focus for keyboard scrolling.
    <section className="definition-table-scroll" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
function RelationshipRows({ items, onOpen }: { items: CapturedRelationship[]; onOpen: Open }) {
  return (
    <ul className="definition-relationships">
      {items.map((item) => (
        <li key={item.object.id}>
          <div className="definition-relationship-heading">
            <Icon name="relationship" />
            <ObjectLink object={item.object} onOpen={onOpen} />
          </div>
          <div className="definition-reference">
            <span>
              {item.source ? <ObjectLink object={item.source} qualified onOpen={onOpen} /> : "Source not captured"}
              <code>({item.columns?.join(", ") ?? "Columns not captured"})</code>
            </span>
            <span role="img" aria-label="references">
              →
            </span>
            <span>
              {item.target ? (
                <ObjectLink object={item.target} qualified onOpen={onOpen} />
              ) : (
                (item.referencedRelation ?? "Target not captured")
              )}
              <code>({item.referencedColumns?.join(", ") ?? "Columns not captured"})</code>
              {!item.target ? <small>Target not resolved in the captured schema</small> : null}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
function ObjectRows({ items, onOpen, kind }: { items: ExplorerObject[]; onOpen: Open; kind: "index" | "constraint" }) {
  return (
    <TableScroll label={kind === "index" ? "Indexes table scroll area" : "Constraints table scroll area"}>
      <table className="definition-table">
        <caption>{kind === "index" ? "Indexes" : "Constraints"}</caption>
        <thead>
          <tr>
            <th>Name</th>
            <th>{kind === "index" ? "Keys / expression" : "Columns"}</th>
            <th>{kind === "index" ? "Method" : "Kind"}</th>
            <th>{kind === "index" ? "Uniqueness" : "Deferrable"}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const fields = capturedFields(item.details);
            return (
              <tr key={item.id}>
                <th scope="row">
                  <ObjectLink object={item} onOpen={onOpen} />
                </th>
                <td>
                  <code>
                    {kind === "index"
                      ? indexColumns(fields.columns)
                      : (capturedNames(fields.columns)?.join(", ") ?? "Not captured")}
                  </code>
                </td>
                <td>
                  <CellValue value={kind === "index" ? fields.method : fields.kind} />
                </td>
                <td>
                  {kind === "index" ? (
                    fields.unique === true ? (
                      "Unique"
                    ) : fields.unique === false ? (
                      "Non-unique"
                    ) : (
                      "Unknown"
                    )
                  ) : (
                    <CellValue value={fields.deferrable} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
function RelationDefinition({
  object,
  catalog,
  onOpen,
}: {
  object: ExplorerObject;
  catalog: ExplorerCatalog;
  onOpen: Open;
}) {
  const model = relationDefinition(object, catalog),
    structural = catalog.schema.coverage === "structural";
  return (
    <>
      <Section title="Columns" count={model.columns.length}>
        {model.columns.length ? (
          <TableScroll label="Columns table scroll area">
            <table className="definition-table definition-columns">
              <caption>Columns</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Database type</th>
                  <th>Nullability</th>
                  <th>Key membership</th>
                </tr>
              </thead>
              <tbody>
                {model.columns.map((column) => {
                  const fields = capturedFields(column.details),
                    keys = columnKeys(column, model.constraints);
                  return (
                    <tr key={column.id}>
                      <th scope="row">
                        <ObjectLink object={column} onOpen={onOpen} />
                      </th>
                      <td>
                        <code>
                          <CellValue value={fields.databaseType} />
                        </code>
                        {typeof fields.tsType === "string" && fields.tsType !== fields.databaseType ? (
                          <small title="TypeScript type">{fields.tsType}</small>
                        ) : null}
                      </td>
                      <td>{capturedNullability(fields.nullable)}</td>
                      <td>
                        {keys.length
                          ? keys.map((key) => (
                              <span className="definition-key" key={key}>
                                {key}
                              </span>
                            ))
                          : structural
                            ? "—"
                            : "Not captured"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <p className="inspection-note">Column definitions are not available in this captured object.</p>
        )}
      </Section>
      <Section title="Outgoing relationships" count={model.outgoing.length}>
        {model.outgoing.length ? (
          <RelationshipRows items={model.outgoing} onOpen={onOpen} />
        ) : (
          <p className="inspection-note">
            {structural
              ? "No outgoing foreign keys in the captured schema."
              : "Foreign-key definitions were not captured."}
          </p>
        )}
      </Section>
      <Section title="Incoming relationships" count={model.incoming.length}>
        {model.incoming.length ? (
          <RelationshipRows items={model.incoming} onOpen={onOpen} />
        ) : (
          <p className="inspection-note">
            {structural
              ? "No incoming foreign keys in the captured schema."
              : "Incoming foreign-key evidence is unavailable."}
          </p>
        )}
      </Section>
      <Section title="Indexes" count={model.indexes.length}>
        {model.indexes.length ? (
          <ObjectRows items={model.indexes} kind="index" onOpen={onOpen} />
        ) : (
          <p className="inspection-note">
            {structural ? "No indexes in the captured schema." : "Index definitions were not captured."}
          </p>
        )}
      </Section>
      <Section title="Constraints" count={model.constraints.length}>
        {model.constraints.length ? (
          <ObjectRows items={model.constraints} kind="constraint" onOpen={onOpen} />
        ) : (
          <p className="inspection-note">
            {structural ? "No constraints in the captured schema." : "Constraint definitions were not captured."}
          </p>
        )}
      </Section>
      {object.kind.includes("view") ? (
        <Section title="View dependencies">
          <p className="inspection-note">
            View dependencies and defining SQL are not captured. Foreign-key relationships above do not establish view
            dependencies.
          </p>
        </Section>
      ) : null}
      {model.historical.length ? (
        <details className="definition-secondary">
          <summary>
            Historical objects <span>{model.historical.length}</span>
          </summary>
          <ul className="definition-object-list">
            {model.historical.map((item) => (
              <li key={item.id}>
                <ObjectLink object={item} onOpen={onOpen} />
                <small>{objectPresence(item) === "removed" ? "Removed" : "Current existence unknown"}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
export function ObjectDefinition({
  object,
  catalog,
  onOpen,
}: {
  object: ExplorerObject;
  catalog: ExplorerCatalog;
  onOpen: Open;
}) {
  const fields = capturedFields(object.details),
    presence = objectPresence(object);
  if (presence) {
    const last = capturedFields(fields.lastCaptured),
      properties = capturedFields(last.properties);
    return Object.keys(properties).length ? (
      <Section title="Last captured properties">
        <Facts fields={properties} />
      </Section>
    ) : (
      <p className="inspection-note">
        A structured definition is not available for this historical object. Inspect its recorded changes in History.
      </p>
    );
  }
  if (isRelation(object)) return <RelationDefinition object={object} catalog={catalog} onOpen={onOpen} />;
  if (object.kind === "enum") {
    const labels = capturedNames(fields.labels);
    return (
      <>
        <Section title="Enum labels" count={labels?.length}>
          {labels ? (
            <ol className="definition-enum-labels">
              {labels.map((label) => (
                <li key={label}>
                  <code>{label}</code>
                </li>
              ))}
            </ol>
          ) : (
            <p className="inspection-note">Enum labels were not captured.</p>
          )}
        </Section>
        <Facts fields={{ "Database type": fields.databaseType, "TypeScript type": fields.tsType }} />
      </>
    );
  }
  if (object.kind === "column")
    return (
      <>
        <Section title="Column">
          <Facts
            fields={{
              "Database type": fields.databaseType,
              "TypeScript type": fields.tsType,
              Nullability: capturedNullability(fields.nullable),
              Default: fields.default,
              Generated: fields.generated,
              Identity: fields.identity,
              Collation: fields.collation,
              Insertable: fields.insertable,
              Updatable: fields.updatable,
            }}
          />
        </Section>
        <LinkedObjects object={object} catalog={catalog} onOpen={onOpen} />
      </>
    );
  if (object.kind === "relationship") {
    const item = capturedRelationship(object, catalog);
    return (
      <>
        <Section title="Foreign key">
          <RelationshipRows items={[item]} onOpen={onOpen} />
          <Facts
            fields={{
              Match: fields.match,
              "On update": fields.onUpdate,
              "On delete": fields.onDelete,
              Deferrable: fields.deferrable,
              "Initially deferred": fields.initiallyDeferred,
            }}
          />
        </Section>
        {typeof fields.constraintId === "string" &&
        catalog.schema.objects.find((item) => item.id === fields.constraintId) ? (
          <Section title="Constraint">
            <ObjectLink
              object={catalog.schema.objects.find((item) => item.id === fields.constraintId)!}
              onOpen={onOpen}
            />
          </Section>
        ) : null}
      </>
    );
  }
  if (object.kind === "index")
    return (
      <>
        <Section title="Index">
          <Facts
            fields={{
              Method: fields.method,
              Keys: indexColumns(fields.columns),
              Unique: fields.unique,
              "Included columns": capturedNames(fields.includedColumns)?.join(", "),
              Predicate: fields.predicate,
              Valid: fields.valid,
            }}
          />
          {fields.predicate === "present" ? (
            <p className="inspection-note">A predicate is present; its expression text is not captured.</p>
          ) : null}
        </Section>
        <LinkedObjects object={object} catalog={catalog} onOpen={onOpen} />
      </>
    );
  if (object.kind === "constraint")
    return (
      <Section title="Constraint">
        <Facts
          fields={{
            Kind: fields.kind,
            Columns: capturedNames(fields.columns)?.join(", "),
            Deferrable: fields.deferrable,
            "Initially deferred": fields.initiallyDeferred,
            Partial: fields.partial,
            "Expression based": fields.expressionBased,
            "Nulls distinct": fields.nullsDistinct,
            "Referenced relation": fields.referencedRelation,
            "Referenced columns": capturedNames(fields.referencedColumns)?.join(", "),
            "On update": fields.onUpdate,
            "On delete": fields.onDelete,
          }}
        />
        {fields.expressionBased === true ? <p className="inspection-note">Expression text is not captured.</p> : null}
      </Section>
    );
  const children = objectChildren(object, catalog).filter((item) => !objectPresence(item));
  return (
    <>
      {children.length ? (
        <Section title="Objects" count={children.length}>
          <ul className="definition-object-list">
            {children.map((item) => (
              <li key={item.id}>
                <ObjectLink object={item} onOpen={onOpen} />
                <small>{item.kind}</small>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Properties">
        <Facts
          fields={Object.fromEntries(
            Object.entries(fields).filter(([key]) => !["exists", "identity", "snapshotKey"].includes(key)),
          )}
        />
      </Section>
      <LinkedObjects object={object} catalog={catalog} onOpen={onOpen} />
    </>
  );
}
function LinkedObjects({
  object,
  catalog,
  onOpen,
}: {
  object: ExplorerObject;
  catalog: ExplorerCatalog;
  onOpen: Open;
}) {
  const links = catalog.schema.links
    .filter(
      (link) =>
        link.kind !== "contains" &&
        link.kind !== "foreign-key" &&
        (link.source === object.id || link.target === object.id),
    )
    .flatMap((link) => {
      const related = catalog.schema.objects.find(
        (item) => item.id === (link.source === object.id ? link.target : link.source),
      );
      return related ? [{ link, object: related }] : [];
    });
  return links.length ? (
    <Section title="Related objects">
      <ul className="definition-object-list">
        {links.map(({ link, object }) => (
          <li key={link.id}>
            <ObjectLink object={object} onOpen={onOpen} />
            <small>{link.kind === "type" ? "Type" : "Index column"}</small>
          </li>
        ))}
      </ul>
    </Section>
  ) : null;
}
