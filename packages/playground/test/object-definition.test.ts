import { describe, it, strict } from "poku";
import type { ExplorerCatalog, ExplorerObject, ExplorerValue } from "../ui/explorer-types.js";
import {
  capturedNullability,
  capturedRelationship,
  columnKeys,
  indexColumns,
  relationDefinition,
} from "../ui/object-definition-model.js";

const object = (
  id: string,
  kind: string,
  parentId?: string,
  details: ExplorerValue = { exists: true },
): ExplorerObject => ({
  id,
  name: id,
  namespace: "exact.namespace",
  kind,
  ...(parentId ? { parentId } : {}),
  details,
  history: [],
  historyState: "unknown",
});
const catalog = (objects: ExplorerObject[], links: ExplorerCatalog["schema"]["links"]): ExplorerCatalog => ({
  schema: { schemaHash: "hash", source: "saved", capturedAt: "captured", coverage: "structural", objects, links },
  migrations: { state: "unavailable", entries: [] },
});
await describe("structured captured object definitions", async () => {
  await it("keeps removed columns outside current schema and preserves captured composite foreign-key order", () => {
    const source = object("source", "table"),
      target = object("target", "table"),
      first = object("first", "column", "source", { exists: true, position: 1 }),
      second = object("second", "column", "source", { exists: true, position: 2 }),
      removed = object("old", "column", "source", { exists: false, historyOnly: true });
    const fk = object("opaque-fk", "relationship", "source", {
      exists: true,
      columns: ["second", "first"],
      referencedColumns: ["target_b", "target_a"],
      referencedRelation: "opaque-relation-identity",
    });
    const state = catalog(
      [source, target, second, removed, first, fk],
      [{ id: "opaque-fk", kind: "foreign-key", source: "source", target: "target" }],
    );
    const definition = relationDefinition(source, state);
    strict.deepEqual(
      definition.columns.map((item) => item.id),
      ["first", "second"],
    );
    strict.deepEqual(
      definition.historical.map((item) => item.id),
      ["old"],
    );
    strict.deepEqual(definition.outgoing[0]?.columns, ["second", "first"]);
    strict.deepEqual(definition.outgoing[0]?.referencedColumns, ["target_b", "target_a"]);
    strict.equal(definition.outgoing[0]?.target?.id, "target");
    strict.equal(relationDefinition(target, state).incoming[0]?.object.id, "opaque-fk");
    strict.equal(
      capturedRelationship(fk, catalog([source, target, fk], [])).target,
      undefined,
      "No endpoint guessing from relation names or SQL",
    );
  });
  await it("uses exact constraint membership and leaves unsupported/nullability/index evidence unknown", () => {
    const column = object("id", "column"),
      primary = object("pk", "constraint", undefined, { columns: ["id", "other"], kind: "primary-key" }),
      foreign = object("fk", "constraint", undefined, { columns: ["id"], kind: "foreign-key" });
    strict.deepEqual(columnKeys(column, [primary, foreign]), ["Primary key", "Foreign key"]);
    strict.deepEqual(columnKeys(object("other_id", "column"), [primary]), []);
    strict.equal(capturedNullability(false), "Not null");
    strict.equal(capturedNullability(true), "Nullable");
    strict.equal(capturedNullability(undefined), "Unknown");
    strict.equal(capturedNullability("unknown"), "Unknown");
    strict.equal(
      indexColumns([{ column: "id", descending: true, nulls: "first" }, { expressionHash: "captured-hash" }]),
      "id DESC NULLS FIRST, Expression (definition not captured)",
    );
    strict.equal(indexColumns(undefined), "Not captured");
  });
});
