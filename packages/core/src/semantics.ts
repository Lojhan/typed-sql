import type { SourceRange } from "./types.js";

export const QUERY_SEMANTICS_VERSION = 1 as const;

export type QueryOperation = "read" | "write" | "ddl" | "transaction-control" | "unknown";
export type QueryVolatility = "immutable" | "stable" | "volatile" | "unknown";
export type QueryLocking = "none" | "row" | "table" | "unknown";
export type QueryConnectionAffinity = "none" | "transaction" | "session" | "unknown";
export type QueryDependencyKind = "relation" | "column" | "function" | "type" | "sequence" | "unknown";
export type QueryDependencyAccess = "read" | "write" | "execute" | "reference" | "unknown";

export interface SemanticEvidence {
  readonly kind: "syntax" | "schema" | "conservative";
  readonly description: string;
  readonly range: SourceRange;
}

export interface SemanticFact<Value extends string> {
  readonly value: Value;
  readonly evidence: readonly SemanticEvidence[];
}

export interface QueryCardinality {
  readonly minimum: 0 | 1;
  readonly maximum: 0 | 1 | "many" | "unknown";
  readonly evidence: readonly SemanticEvidence[];
}

export interface QueryDependency {
  readonly kind: QueryDependencyKind;
  readonly access: QueryDependencyAccess;
  readonly name: string;
  readonly schema?: string;
  readonly parent?: string;
  readonly certainty: "resolved" | "syntactic";
  readonly range: SourceRange;
}

/** Evidence produced by a grammar for one complete SQL statement. */
export interface QuerySemantics {
  readonly version: typeof QUERY_SEMANTICS_VERSION;
  readonly operation: SemanticFact<QueryOperation>;
  readonly dependencies: readonly QueryDependency[];
  readonly cardinality: QueryCardinality;
  readonly volatility: SemanticFact<QueryVolatility>;
  readonly locking: SemanticFact<QueryLocking>;
  readonly connectionAffinity: SemanticFact<QueryConnectionAffinity>;
  readonly capabilities: readonly string[];
}

/** Canonicalizes and deeply freezes grammar-produced semantic evidence. */
export function defineQuerySemantics(semantics: QuerySemantics): QuerySemantics {
  if (semantics.version !== QUERY_SEMANTICS_VERSION) {
    throw new TypeError(`Unsupported query semantics version ${String(semantics.version)}`);
  }
  const evidence = (values: readonly SemanticEvidence[]) =>
    Object.freeze(
      [...values]
        .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)))
        .map((value) => Object.freeze({ ...value, range: Object.freeze({ ...value.range }) })),
    );
  const fact = <Value extends string>(value: SemanticFact<Value>): SemanticFact<Value> =>
    Object.freeze({ value: value.value, evidence: evidence(value.evidence) });
  return Object.freeze({
    version: QUERY_SEMANTICS_VERSION,
    operation: fact(semantics.operation),
    dependencies: Object.freeze(
      [...semantics.dependencies]
        .sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right)))
        .map((dependency) => Object.freeze({ ...dependency, range: Object.freeze({ ...dependency.range }) })),
    ),
    cardinality: Object.freeze({
      minimum: semantics.cardinality.minimum,
      maximum: semantics.cardinality.maximum,
      evidence: evidence(semantics.cardinality.evidence),
    }),
    volatility: fact(semantics.volatility),
    locking: fact(semantics.locking),
    connectionAffinity: fact(semantics.connectionAffinity),
    capabilities: Object.freeze([...new Set(semantics.capabilities)].sort()),
  });
}

export function unknownQuerySemantics(range: SourceRange, description: string): QuerySemantics {
  const evidence = Object.freeze([{ kind: "conservative" as const, description, range }]);
  return defineQuerySemantics({
    version: QUERY_SEMANTICS_VERSION,
    operation: Object.freeze({ value: "unknown", evidence }),
    dependencies: Object.freeze([]),
    cardinality: Object.freeze({ minimum: 0, maximum: "unknown", evidence }),
    volatility: Object.freeze({ value: "unknown", evidence }),
    locking: Object.freeze({ value: "unknown", evidence }),
    connectionAffinity: Object.freeze({ value: "unknown", evidence }),
    capabilities: Object.freeze([]),
  });
}

export function mapQuerySemanticRanges(
  semantics: QuerySemantics,
  map: (range: SourceRange) => SourceRange,
): QuerySemantics {
  const evidence = (values: readonly SemanticEvidence[]) =>
    Object.freeze(values.map((value) => Object.freeze({ ...value, range: map(value.range) })));
  const fact = <Value extends string>(value: SemanticFact<Value>): SemanticFact<Value> =>
    Object.freeze({ value: value.value, evidence: evidence(value.evidence) });
  return defineQuerySemantics({
    ...semantics,
    operation: fact(semantics.operation),
    dependencies: Object.freeze(
      semantics.dependencies.map((dependency) => Object.freeze({ ...dependency, range: map(dependency.range) })),
    ),
    cardinality: Object.freeze({ ...semantics.cardinality, evidence: evidence(semantics.cardinality.evidence) }),
    volatility: fact(semantics.volatility),
    locking: fact(semantics.locking),
    connectionAffinity: fact(semantics.connectionAffinity),
  });
}

function evidenceKey(value: SemanticEvidence): string {
  return `${value.range.start}\0${value.range.end}\0${value.kind}\0${value.description}`;
}

function mergeEvidence(values: readonly (readonly SemanticEvidence[])[]): readonly SemanticEvidence[] {
  const merged = new Map<string, SemanticEvidence>();
  for (const value of values.flat()) merged.set(evidenceKey(value), value);
  return [...merged.values()].sort(
    (left, right) =>
      left.range.start - right.range.start ||
      left.range.end - right.range.end ||
      left.kind.localeCompare(right.kind) ||
      left.description.localeCompare(right.description),
  );
}

function mergeFact<Value extends string>(facts: readonly SemanticFact<Value>[], unknown: Value): SemanticFact<Value> {
  const first = facts[0]?.value ?? unknown;
  return {
    value: facts.every((fact) => fact.value === first) ? first : unknown,
    evidence: mergeEvidence(facts.map((fact) => fact.evidence)),
  };
}

function mergeRankedFact<Value extends string>(
  facts: readonly SemanticFact<Value>[],
  ranks: Readonly<Record<Value, number>>,
): SemanticFact<Value> {
  const value = facts.reduce(
    (current, fact) => (ranks[fact.value] > ranks[current] ? fact.value : current),
    facts[0]!.value,
  );
  return { value, evidence: mergeEvidence(facts.map((fact) => fact.evidence)) };
}

function dependencyKey(value: QueryDependency): string {
  return [
    value.kind,
    value.access,
    value.schema ?? "",
    value.parent ?? "",
    value.name,
    value.certainty,
    value.range.start,
    value.range.end,
  ].join("\0");
}

const cardinalityMaximum = { 0: 0, 1: 1, many: 2, unknown: 3 } as const;

/** Conservatively merges every possible structural query variant. */
export function mergeQuerySemantics(variants: readonly QuerySemantics[]): QuerySemantics {
  if (variants.length === 0) throw new TypeError("At least one query semantic variant is required");
  const dependencies = new Map<string, QueryDependency>();
  for (const dependency of variants.flatMap((variant) => variant.dependencies)) {
    dependencies.set(dependencyKey(dependency), dependency);
  }
  const maximum = variants.reduce<QueryCardinality["maximum"]>(
    (current, variant) =>
      cardinalityMaximum[variant.cardinality.maximum] > cardinalityMaximum[current]
        ? variant.cardinality.maximum
        : current,
    0,
  );
  return defineQuerySemantics({
    version: QUERY_SEMANTICS_VERSION,
    operation: mergeFact(
      variants.map((variant) => variant.operation),
      "unknown",
    ),
    dependencies: Object.freeze(
      [...dependencies.values()].sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right))),
    ),
    cardinality: Object.freeze({
      minimum: variants.some((variant) => variant.cardinality.minimum === 0) ? 0 : 1,
      maximum,
      evidence: mergeEvidence(variants.map((variant) => variant.cardinality.evidence)),
    }),
    volatility: mergeRankedFact(
      variants.map((variant) => variant.volatility),
      {
        immutable: 0,
        stable: 1,
        volatile: 2,
        unknown: 3,
      },
    ),
    locking: mergeRankedFact(
      variants.map((variant) => variant.locking),
      {
        none: 0,
        row: 1,
        table: 2,
        unknown: 3,
      },
    ),
    connectionAffinity: mergeRankedFact(
      variants.map((variant) => variant.connectionAffinity),
      {
        none: 0,
        transaction: 1,
        session: 2,
        unknown: 3,
      },
    ),
    capabilities: Object.freeze([...new Set(variants.flatMap((variant) => variant.capabilities))].sort()),
  });
}
