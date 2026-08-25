import type { ExtractedQuery, StructuralOperand } from "./scanner.js";
import { extractStructuralOperand, parseStructuralInterpolation } from "./scanner.js";

export interface ExpandedStructuralVariant {
  readonly query: ExtractedQuery;
  readonly choices: ReadonlyMap<string, boolean>;
  readonly fragments: readonly {
    readonly query: ExtractedQuery;
    readonly parameterOffset: number;
  }[];
}

export type StructuralExpansion =
  | { readonly kind: "variants"; readonly variants: readonly ExpandedStructuralVariant[] }
  | { readonly kind: "limit"; readonly conditionCount: number; readonly variantCount: number };

interface StructuralState {
  readonly sqlChunks: readonly string[];
  readonly offsetChunks: readonly (readonly number[])[];
  readonly count: number;
  readonly cursor: number;
  readonly choices: ReadonlyMap<string, boolean>;
  readonly fragments: readonly {
    readonly query: ExtractedQuery;
    readonly parameterOffset: number;
  }[];
}

function variantCount(conditionCount: number, maximum: number): number {
  let count = 1;
  for (let index = 0; index < conditionCount; index += 1) {
    if (count > maximum / 2) return maximum + 1;
    count *= 2;
  }
  return count;
}

function withParameterOffset(
  query: ExtractedQuery,
  offset: number,
  placeholder: (index: number) => string,
): ExtractedQuery {
  if (offset === 0 || query.parameterCount === 0) return query;
  const sqlChunks: string[] = [];
  const offsetChunks: (readonly number[])[] = [];
  let cursor = 0;
  for (const interpolation of query.interpolations) {
    sqlChunks.push(query.sql.slice(cursor, interpolation.sqlStart));
    offsetChunks.push(query.sqlOffsetMap.slice(cursor, interpolation.sqlStart));
    const marker = placeholder(offset + interpolation.index);
    sqlChunks.push(marker);
    offsetChunks.push(Array.from({ length: marker.length }, () => interpolation.sourceStart));
    cursor = interpolation.sqlEnd;
  }
  sqlChunks.push(query.sql.slice(cursor));
  offsetChunks.push(query.sqlOffsetMap.slice(cursor));
  return { ...query, sql: sqlChunks.join(""), sqlOffsetMap: offsetChunks.flat() };
}

/**
 * Expands TypeScript-level SQL structure without interpreting SQL. Every completed statement is
 * still resolved exclusively by the configured dialect plugin.
 */
export function expandStructuralQuery(
  source: string,
  query: ExtractedQuery,
  placeholder: (index: number) => string,
  maximumVariants: number,
): StructuralExpansion | undefined {
  const parsed = query.interpolations.map((interpolation) =>
    parseStructuralInterpolation(source, interpolation, query.tagName),
  );
  if (!parsed.some((value) => value !== undefined)) return undefined;

  const conditions = new Set(parsed.flatMap((value) => (value?.condition === undefined ? [] : [value.condition])));
  const possibleVariants = variantCount(conditions.size, maximumVariants);
  if (possibleVariants > maximumVariants) {
    return { kind: "limit", conditionCount: conditions.size, variantCount: possibleVariants };
  }

  const localFragments = new Map<number, ExtractedQuery>();
  const register = (operand: StructuralOperand | undefined): void => {
    if (operand?.kind !== "fragment" || localFragments.has(operand.start)) return;
    const fragment = extractStructuralOperand(source, operand, query.tagName, placeholder, 0);
    if (fragment !== undefined) localFragments.set(operand.start, fragment);
  };
  for (const structural of parsed) {
    register(structural?.truthy);
    register(structural?.falsy);
  }
  const offsetFragments = new Map<string, ExtractedQuery>();
  const fragmentAt = (operand: StructuralOperand, offset: number): ExtractedQuery | undefined => {
    const local = localFragments.get(operand.start);
    if (local === undefined) return undefined;
    const key = `${operand.start}:${offset}`;
    const cached = offsetFragments.get(key);
    if (cached !== undefined) return cached;
    const adjusted = withParameterOffset(local, offset, placeholder);
    offsetFragments.set(key, adjusted);
    return adjusted;
  };

  let states: readonly StructuralState[] = [
    {
      sqlChunks: [],
      offsetChunks: [],
      count: 0,
      cursor: 0,
      choices: new Map(),
      fragments: [],
    },
  ];
  const appendOperand = (state: StructuralState, operand: StructuralOperand): StructuralState => {
    if (operand.kind === "empty") return state;
    const fragment = fragmentAt(operand, state.count);
    if (fragment === undefined) return state;
    return {
      ...state,
      sqlChunks: [...state.sqlChunks, fragment.sql],
      offsetChunks: [...state.offsetChunks, fragment.sqlOffsetMap],
      count: state.count + fragment.parameterCount,
      fragments: [...state.fragments, { query: fragment, parameterOffset: state.count }],
    };
  };

  query.interpolations.forEach((interpolation, interpolationIndex) => {
    const structural = parsed[interpolationIndex];
    const next: StructuralState[] = [];
    for (const state of states) {
      const base: StructuralState = {
        ...state,
        sqlChunks: [...state.sqlChunks, query.sql.slice(state.cursor, interpolation.sqlStart)],
        offsetChunks: [...state.offsetChunks, query.sqlOffsetMap.slice(state.cursor, interpolation.sqlStart)],
        cursor: interpolation.sqlEnd,
      };
      if (structural === undefined) {
        const marker = placeholder(base.count + 1);
        next.push({
          ...base,
          sqlChunks: [...base.sqlChunks, marker],
          offsetChunks: [...base.offsetChunks, Array.from({ length: marker.length }, () => interpolation.sourceStart)],
          count: base.count + 1,
        });
      } else if (structural.condition === undefined || structural.falsy === undefined) {
        next.push(appendOperand(base, structural.truthy));
      } else {
        const known = base.choices.get(structural.condition);
        for (const enabled of known === undefined ? [true, false] : [known]) {
          const choices = new Map(base.choices);
          choices.set(structural.condition, enabled);
          next.push(appendOperand({ ...base, choices }, enabled ? structural.truthy : structural.falsy));
        }
      }
    }
    states = next;
  });

  return {
    kind: "variants",
    variants: states.map((state) => ({
      query: {
        ...query,
        sql: [...state.sqlChunks, query.sql.slice(state.cursor)].join(""),
        sqlOffsetMap: [...state.offsetChunks, query.sqlOffsetMap.slice(state.cursor)].flat(),
        parameterCount: state.count,
      },
      choices: state.choices,
      fragments: state.fragments,
    })),
  };
}

function typeAnnotationBefore(source: string, position: number, binding: string): string | undefined {
  const prefix = source.slice(0, position);
  const parameter = new RegExp(`\\b${binding}\\s*:\\s*`, "gu");
  let type: string | undefined;
  for (let match = parameter.exec(prefix); match !== null; match = parameter.exec(prefix)) {
    const start = parameter.lastIndex;
    let index = start;
    let round = 0;
    let square = 0;
    let curly = 0;
    let angle = 0;
    while (index < prefix.length) {
      const char = prefix[index];
      if (char === '"' || char === "'") {
        const quote = char;
        index += 1;
        while (index < prefix.length && prefix[index] !== quote) {
          index += prefix[index] === "\\" ? 2 : 1;
        }
      } else if (char === "(") round += 1;
      else if (char === ")") {
        if (round === 0 && square === 0 && curly === 0 && angle === 0) break;
        round -= 1;
      } else if (char === "[") square += 1;
      else if (char === "]") square -= 1;
      else if (char === "{") curly += 1;
      else if (char === "}") curly -= 1;
      else if (char === "<") angle += 1;
      else if (char === ">" && angle > 0) angle -= 1;
      else if ((char === "," || char === "=") && round === 0 && square === 0 && curly === 0 && angle === 0) break;
      index += 1;
    }
    const candidate = prefix.slice(start, index).trim();
    if (candidate.length > 0) type = candidate;
  }
  return type;
}

function conditionType(source: string, position: number, condition: string): string | undefined {
  const property = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)|\[(["'])([^"']+)\3\])$/u.exec(condition);
  if (property === null) return undefined;
  const type = typeAnnotationBefore(source, position, property[1]!);
  const key = property[2] ?? property[4];
  if (type === undefined || key === undefined) return undefined;
  const owner = /^[A-Za-z_$][\w$]*$/u.test(type) ? type : `(${type})`;
  return `${owner}[${JSON.stringify(key)}]`;
}

function parenthesizeConditional(type: string): string {
  return type.includes(" extends ") ? `(${type})` : type;
}

export function structuralRowType(
  source: string,
  original: ExtractedQuery,
  rows: readonly { readonly row: string; readonly choices: ReadonlyMap<string, boolean> }[],
): string {
  const resolve = (candidates: typeof rows, remaining: readonly string[]): string => {
    const unique = [...new Set(candidates.map((item) => item.row))];
    if (unique.length === 1) return unique[0]!;
    const [condition, ...rest] = remaining;
    if (condition === undefined) return unique.join(" | ");
    const type = conditionType(source, original.range.start, condition);
    if (type === undefined) return resolve(candidates, rest);
    const truthy = candidates.filter((item) => item.choices.get(condition) === true);
    const falsy = candidates.filter((item) => item.choices.get(condition) === false);
    if (truthy.length === 0 || falsy.length === 0) return resolve(candidates, rest);
    const truthyType = resolve(truthy, rest);
    const falsyType = resolve(falsy, rest);
    if (truthyType === falsyType) return truthyType;
    return `${type} extends true ? ${parenthesizeConditional(truthyType)} : ${type} extends false ? ${parenthesizeConditional(falsyType)} : ${parenthesizeConditional(truthyType)} | ${parenthesizeConditional(falsyType)}`;
  };
  const conditions = [...new Set(rows.flatMap((item) => [...item.choices.keys()]))];
  return resolve(rows, conditions);
}
