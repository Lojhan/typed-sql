import type {
  ColumnSnapshot,
  FunctionSnapshot,
  ResolvedParameter,
  SchemaSnapshot,
  StructuralColumnSnapshot,
  StructuralRelationSnapshot,
  StructuralRoutineSnapshot,
  TableSnapshot,
} from "./types.js";

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
    if (
      current === undefined ||
      (current.tsType === "unknown" && candidate.tsType !== "unknown") ||
      (current.databaseType === undefined && candidate.databaseType !== undefined)
    ) {
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

export { closestName } from "./name-suggestions.js";

export interface IndexedTable {
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
  readonly #routines = new Map<string, StructuralRoutineSnapshot[]>();
  readonly #routinesByName = new Map<string, StructuralRoutineSnapshot[]>();
  readonly #relationEvidence = new WeakMap<TableSnapshot, StructuralRelationSnapshot>();

  constructor(snapshot: SchemaSnapshot) {
    for (const [key, table] of Object.entries(snapshot.tables)) {
      const indexed = { key, table };
      const unqualifiedKey = key.slice(key.lastIndexOf(".") + 1);
      for (const candidate of new Set([key, unqualifiedKey, table.name])) {
        addToIndex(this.#exactTables, candidate, indexed);
        addToIndex(this.#foldedTables, candidate.toLowerCase(), indexed);
      }
      this.#indexColumns(table);
      const relation = snapshot.relations?.[key];
      if (relation !== undefined) this.#relationEvidence.set(table, relation);
    }
    if (snapshot.routines !== undefined) {
      for (const overloads of Object.values(snapshot.routines)) {
        for (const routine of overloads) {
          const inputs = routine.arguments.filter(({ mode }) => mode !== "out");
          addToIndex(this.#routines, `${routine.name.toLowerCase()}/${inputs.length}`, routine);
          addToIndex(this.#routinesByName, routine.name.toLowerCase(), routine);
          if (routine.kind === "procedure") continue;
          const result = routine.result;
          const value: FunctionSnapshot = {
            name: routine.name,
            ...(routine.schema === undefined ? {} : { schema: routine.schema }),
            argumentTypes: inputs.map(({ databaseType }) => databaseType),
            ...(result.kind === "scalar" || result.kind === "set"
              ? { databaseReturnType: result.databaseType, returnType: result.tsType, nullable: result.nullable }
              : { databaseReturnType: result.kind, returnType: "unknown", nullable: true }),
            ...(result.kind === "set" ? { setReturning: true } : {}),
            ...(routine.volatility === "unknown" ? {} : { volatility: routine.volatility }),
          };
          addToIndex(this.#functions, `${value.name.toLowerCase()}/${value.argumentTypes.length}`, value);
        }
      }
    } else {
      for (const value of Object.values(snapshot.functions ?? {})) {
        addToIndex(this.#functions, `${value.name.toLowerCase()}/${value.argumentTypes.length}`, value);
      }
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

  routineOverloads(name: string, arity: number, schema?: string): readonly StructuralRoutineSnapshot[] {
    const exact = this.#routines.get(`${name.toLowerCase()}/${arity}`) ?? [];
    const flexible = (this.#routinesByName.get(name.toLowerCase()) ?? []).filter((candidate) => {
      const inputs = candidate.arguments.filter(({ mode }) => mode !== "out");
      const variadic = inputs.at(-1)?.mode === "variadic";
      const fixed = variadic ? inputs.slice(0, -1) : inputs;
      const required = fixed.filter(({ default: defaultValue }) => defaultValue !== "present").length;
      return arity >= required && (variadic || arity <= inputs.length);
    });
    const matches = [...new Set([...exact, ...flexible])];
    return schema === undefined
      ? matches
      : matches.filter((candidate) => candidate.schema?.toLowerCase() === schema.toLowerCase());
  }

  /** Returns exact v2 structural evidence or undefined for v1/derived relations. */
  relation(table: TableSnapshot): StructuralRelationSnapshot | undefined {
    return this.#relationEvidence.get(table);
  }

  uniqueColumnSets(table: TableSnapshot): readonly (readonly string[])[] {
    return (
      this.#relationEvidence
        .get(table)
        ?.constraints.filter(
          (constraint) =>
            (constraint.kind === "primary-key" || constraint.kind === "unique") &&
            constraint.partial === false &&
            constraint.expressionBased === false,
        )
        .map(({ columns }) => columns) ?? []
    );
  }

  isUnique(table: TableSnapshot, columns: readonly string[]): boolean | "unknown" {
    const relation = this.#relationEvidence.get(table);
    if (relation === undefined) return "unknown";
    const requested = new Set(columns.map((column) => column.toLowerCase()));
    return relation.constraints.some(
      (constraint) =>
        (constraint.kind === "primary-key" || constraint.kind === "unique") &&
        constraint.partial === false &&
        constraint.expressionBased === false &&
        constraint.columns.length === requested.size &&
        constraint.columns.every((column) => requested.has(column.toLowerCase())),
    );
  }

  columnEvidence(table: TableSnapshot, column: ColumnSnapshot): StructuralColumnSnapshot | undefined {
    const relation = this.#relationEvidence.get(table);
    if (relation === undefined) return undefined;
    return relation.columns[column.name] ?? Object.values(relation.columns).find(({ name }) => name === column.name);
  }

  columnEligibility(table: TableSnapshot, column: ColumnSnapshot, operation: "insert" | "update"): boolean | "unknown" {
    const evidence = this.columnEvidence(table, column);
    return evidence === undefined ? "unknown" : operation === "insert" ? evidence.insertable : evidence.updatable;
  }

  requiredInsertColumns(table: TableSnapshot): readonly StructuralColumnSnapshot[] | "unknown" {
    const relation = this.#relationEvidence.get(table);
    if (relation === undefined) return "unknown";
    return Object.values(relation.columns)
      .filter(
        (column) =>
          column.insertable === true &&
          column.nullable === false &&
          column.default === "none" &&
          column.generated === "none" &&
          column.identity === "none",
      )
      .sort((left, right) => left.position - right.position);
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
