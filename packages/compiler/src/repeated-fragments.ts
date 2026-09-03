import { DEFAULT_MAX_FRAGMENT_LIST_ITEMS, type SourceRange, type SqlDiagnostic } from "@typed-sql/core";
import { discoverRepeatedFragmentInterpolation, type ExtractedQuery, extractStructuralOperand } from "./scanner.js";

export interface RepeatedFragmentSite {
  readonly sourceSpan: SourceRange;
  readonly dynamic: boolean;
  readonly representativeItems: 1 | 2;
  readonly element: ExtractedQuery;
  readonly parameterOffset: number;
}

export interface RepeatedFragmentExpansion {
  readonly query: ExtractedQuery;
  readonly sites: readonly RepeatedFragmentSite[];
  readonly fragments: readonly { readonly query: ExtractedQuery; readonly parameterOffset: number }[];
  readonly diagnostics: readonly SqlDiagnostic[];
}

export function expandRepeatedFragments(
  source: string,
  query: ExtractedQuery,
  placeholder: (index: number) => string,
  maximumItems = DEFAULT_MAX_FRAGMENT_LIST_ITEMS,
): RepeatedFragmentExpansion | undefined {
  const discoveries = query.interpolations.map((interpolation) =>
    discoverRepeatedFragmentInterpolation(source, interpolation, query.tagName),
  );
  if (discoveries.every(({ kind }) => kind === "none")) return undefined;
  const diagnostics: SqlDiagnostic[] = discoveries.flatMap((discovery) =>
    discovery.kind === "error"
      ? [
          {
            code: discovery.code,
            message: discovery.message,
            range: discovery.range,
            severity: "error" as const,
            suggestion: discovery.suggestion,
          },
        ]
      : [],
  );
  if (diagnostics.length > 0) {
    return { query, sites: [], fragments: [], diagnostics: Object.freeze(diagnostics) };
  }

  const sql: string[] = [];
  const sqlOffsets: number[][] = [];
  const interpolations = [];
  const sites: RepeatedFragmentSite[] = [];
  const fragments: { readonly query: ExtractedQuery; readonly parameterOffset: number }[] = [];
  let cursor = 0;
  let parameterCount = 0;

  for (let index = 0; index < query.interpolations.length; index += 1) {
    const interpolation = query.interpolations[index]!;
    const discovery = discoveries[index]!;
    sql.push(query.sql.slice(cursor, interpolation.sqlStart));
    sqlOffsets.push(query.sqlOffsetMap.slice(cursor, interpolation.sqlStart));
    cursor = interpolation.sqlEnd;

    if (discovery.kind === "none") {
      parameterCount += 1;
      const marker = placeholder(parameterCount);
      const sqlStart = sql.reduce((length, chunk) => length + chunk.length, 0);
      sql.push(marker);
      sqlOffsets.push(Array.from({ length: marker.length }, () => interpolation.sourceStart));
      interpolations.push({
        ...interpolation,
        index: parameterCount,
        sqlStart,
        sqlEnd: sqlStart + marker.length,
      });
      continue;
    }
    if (discovery.kind !== "fragments") continue;
    const itemCount = discovery.dynamic ? discovery.representativeItems : discovery.elements.length;
    if (itemCount > maximumItems) {
      diagnostics.push({
        code: "TSQ015",
        message: `Fragment list contains ${itemCount} items; the compiler limit is ${maximumItems}.`,
        range: discovery.range,
        severity: "error",
        suggestion: "Use a bounded list, a batch API, or a grammar-specific bulk protocol.",
      });
      continue;
    }
    let first: ExtractedQuery | undefined;
    const siteOffset = parameterCount;
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const operand = discovery.elements[discovery.dynamic ? 0 : itemIndex]!;
      const fragment = extractStructuralOperand(source, operand, query.tagName, placeholder, parameterCount);
      if (fragment === undefined) continue;
      if (itemIndex > 0) {
        sql.push(", ");
        sqlOffsets.push([discovery.range.start, discovery.range.start]);
      }
      sql.push(fragment.sql);
      sqlOffsets.push([...fragment.sqlOffsetMap]);
      fragments.push({ query: fragment, parameterOffset: parameterCount });
      first ??= fragment;
      parameterCount += fragment.parameterCount;
    }
    for (const alternative of discovery.dynamic ? discovery.elements.slice(1) : []) {
      const fragment = extractStructuralOperand(source, alternative, query.tagName, placeholder, siteOffset);
      if (fragment !== undefined) fragments.push({ query: fragment, parameterOffset: siteOffset });
    }
    if (first !== undefined) {
      sites.push({
        sourceSpan: discovery.range,
        dynamic: discovery.dynamic,
        representativeItems: discovery.representativeItems,
        element: first,
        parameterOffset: siteOffset,
      });
    }
  }
  sql.push(query.sql.slice(cursor));
  sqlOffsets.push([...query.sqlOffsetMap.slice(cursor)]);
  return {
    query: {
      ...query,
      sql: sql.join(""),
      sqlOffsetMap: Object.freeze(sqlOffsets.flat()),
      parameterCount,
      interpolations: Object.freeze(interpolations),
    },
    sites: Object.freeze(sites),
    fragments: Object.freeze(fragments),
    diagnostics: Object.freeze(diagnostics),
  };
}
