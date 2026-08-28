import type { ColumnSnapshot, FunctionSnapshot, ResolvedParameter, SchemaSnapshot, TableSnapshot } from "./types.js";

export interface ResolverType {
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

/** Shared parameter inference state for grammar implementations. */
export class ParameterCollector {
  readonly #parameters = new Map<number, ResolvedParameter>();
  readonly #conflicts = new Map<number, ResolvedParameter>();

  record(index: number, expected?: ResolverType): ResolverType {
    const candidate: ResolvedParameter =
      expected === undefined ? { index, tsType: "unknown", nullable: true } : { index, ...expected };
    const current = this.#parameters.get(index);
    const existingConflict = this.#conflicts.get(index);
    if (existingConflict !== undefined) return existingConflict;
    if (current === undefined || (current.tsType === "unknown" && candidate.tsType !== "unknown")) {
      this.#parameters.set(index, candidate);
      return candidate;
    }
    if (candidate.tsType === "unknown") return current;
    if (current.tsType !== candidate.tsType) {
      const conflict: ResolvedParameter = { index, tsType: "unknown", nullable: true };
      this.#parameters.set(index, conflict);
      this.#conflicts.set(index, conflict);
      return conflict;
    }
    const merged: ResolvedParameter = {
      index,
      tsType: current.tsType,
      nullable: current.nullable || candidate.nullable,
      ...(current.databaseType === candidate.databaseType && current.databaseType !== undefined
        ? { databaseType: current.databaseType }
        : {}),
    };
    this.#parameters.set(index, merged);
    return merged;
  }

  values(): readonly ResolvedParameter[] {
    return [...this.#parameters.values()].sort((left, right) => left.index - right.index);
  }
}

export function unionTypeLiterals(types: readonly string[]): string {
  const distinct = [...new Set(types)];
  return distinct.includes("unknown") ? "unknown" : distinct.join(" | ") || "unknown";
}

function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let column = 1; column <= right.length; column += 1) {
    let diagonal = rows[0]!;
    rows[0] = column;
    for (let row = 1; row <= left.length; row += 1) {
      const above = rows[row]!;
      rows[row] = Math.min(
        rows[row]! + 1,
        rows[row - 1]! + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return rows[left.length]!;
}

export function closestName(name: string, candidates: readonly string[]): string | undefined {
  let closest: string | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest !== undefined && closestDistance <= Math.max(2, Math.floor(name.length / 2)) ? closest : undefined;
}

interface IndexedTable {
  readonly key: string;
  readonly table: TableSnapshot;
}

function addToIndex<Value>(index: Map<string, Value[]>, key: string, value: Value): void {
  const values = index.get(key);
  if (values === undefined) index.set(key, [value]);
  else if (!values.includes(value)) values.push(value);
}

/** Precomputed case-sensitive and folded schema lookups shared by SQL grammars. */
export class ResolverSchemaIndex {
  static readonly #cache = new WeakMap<SchemaSnapshot, ResolverSchemaIndex>();

  /** Reuses immutable snapshot indexes across resolver and semantic passes. */
  static for(snapshot: SchemaSnapshot): ResolverSchemaIndex {
    const cached = ResolverSchemaIndex.#cache.get(snapshot);
    if (cached !== undefined) return cached;
    const index = new ResolverSchemaIndex(snapshot);
    ResolverSchemaIndex.#cache.set(snapshot, index);
    return index;
  }

  readonly #exactTables = new Map<string, IndexedTable[]>();
  readonly #foldedTables = new Map<string, IndexedTable[]>();
  readonly #exactColumns = new WeakMap<TableSnapshot, ReadonlyMap<string, ColumnSnapshot>>();
  readonly #foldedColumns = new WeakMap<TableSnapshot, ReadonlyMap<string, ColumnSnapshot>>();
  readonly #functions = new Map<string, FunctionSnapshot[]>();

  constructor(snapshot: SchemaSnapshot) {
    for (const [key, table] of Object.entries(snapshot.tables)) {
      const indexed = { key, table };
      const unqualifiedKey = key.slice(key.lastIndexOf(".") + 1);
      for (const candidate of new Set([key, unqualifiedKey, table.name])) {
        addToIndex(this.#exactTables, candidate, indexed);
        addToIndex(this.#foldedTables, candidate.toLowerCase(), indexed);
      }
      this.#indexColumns(table);
    }
    for (const value of Object.values(snapshot.functions ?? {})) {
      addToIndex(this.#functions, `${value.name.toLowerCase()}/${value.argumentTypes.length}`, value);
    }
  }

  tables(name: string, schema?: string, caseSensitive = false): readonly IndexedTable[] {
    const index = caseSensitive ? this.#exactTables : this.#foldedTables;
    const matches = index.get(caseSensitive ? name : name.toLowerCase()) ?? [];
    if (schema === undefined) return matches;
    return matches.filter(({ key, table }) => {
      const tableSchema = table.schema ?? key.slice(0, Math.max(0, key.lastIndexOf(".")));
      return caseSensitive ? tableSchema === schema : tableSchema.toLowerCase() === schema.toLowerCase();
    });
  }

  column(table: TableSnapshot, name: string, caseSensitive = false): ColumnSnapshot | undefined {
    if (!this.#exactColumns.has(table)) this.#indexColumns(table);
    const index = caseSensitive ? this.#exactColumns : this.#foldedColumns;
    return index.get(table)?.get(caseSensitive ? name : name.toLowerCase());
  }

  functions(name: string, arity: number, schema?: string): readonly FunctionSnapshot[] {
    const matches = this.#functions.get(`${name.toLowerCase()}/${arity}`) ?? [];
    return schema === undefined
      ? matches
      : matches.filter((candidate) => candidate.schema?.toLowerCase() === schema.toLowerCase());
  }

  #indexColumns(table: TableSnapshot): void {
    const exactColumns = new Map<string, ColumnSnapshot>();
    const foldedColumns = new Map<string, ColumnSnapshot>();
    for (const [columnKey, column] of Object.entries(table.columns)) {
      exactColumns.set(columnKey, column);
      exactColumns.set(column.name, column);
      foldedColumns.set(columnKey.toLowerCase(), column);
      foldedColumns.set(column.name.toLowerCase(), column);
    }
    this.#exactColumns.set(table, exactColumns);
    this.#foldedColumns.set(table, foldedColumns);
  }
}
