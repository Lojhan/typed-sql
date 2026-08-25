import {
  parameterTypeLiteral,
  rowTypeLiteral,
  type DialectPlugin,
  type ResolvedParameter,
  type SchemaSnapshot,
  type SqlDiagnostic,
} from "@typed-sql/core";
import {
  extractAppendFragments,
  extractStructuralOperand,
  extractStaticQueries,
  mapSqlRange,
  parseStructuralInterpolation,
  type ExtractedQuery,
  type StructuralOperand,
} from "./scanner.js";

export interface CompiledQuery {
  readonly query: ExtractedQuery;
  readonly rowType: string;
  readonly parameterType: string;
  readonly structural?: boolean;
}

export interface CompiledFragment {
  readonly fragment: ExtractedQuery;
  readonly parameterType: string;
}

export interface CompileSourceResult {
  readonly transformedSource: string;
  readonly queries: readonly CompiledQuery[];
  readonly fragments: readonly CompiledFragment[];
  readonly diagnostics: readonly SqlDiagnostic[];
}

export interface CompileSourceOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly source: string;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
}

function mapDiagnostic(source: string, query: ExtractedQuery, diagnostic: SqlDiagnostic): SqlDiagnostic {
  return { ...diagnostic, range: mapSqlRange(source, query, diagnostic.range) };
}

interface ExpandedVariant {
  readonly query: ExtractedQuery;
  readonly choices: ReadonlyMap<string, boolean>;
  readonly fragments: readonly { readonly query: ExtractedQuery; readonly parameterOffset: number }[];
}

function expandStructuralQuery(
  source: string,
  query: ExtractedQuery,
  placeholder: (index: number) => string,
): readonly ExpandedVariant[] | undefined {
  const parsed = query.interpolations.map((interpolation) =>
    parseStructuralInterpolation(source, interpolation, query.tagName));
  if (!parsed.some((value) => value !== undefined)) return undefined;
  type State = {
    sql: string;
    offsets: number[];
    count: number;
    cursor: number;
    choices: Map<string, boolean>;
    fragments: { query: ExtractedQuery; parameterOffset: number }[];
  };
  let states: State[] = [{ sql: "", offsets: [], count: 0, cursor: 0, choices: new Map(), fragments: [] }];
  const appendOperand = (state: State, operand: StructuralOperand): State => {
    if (operand.kind === "empty") return state;
    const fragment = extractStructuralOperand(source, operand, query.tagName, placeholder, state.count);
    if (fragment === undefined) return state;
    return {
      ...state,
      sql: state.sql + fragment.sql,
      offsets: [...state.offsets, ...fragment.sqlOffsetMap],
      count: state.count + fragment.parameterCount,
      fragments: [...state.fragments, { query: fragment, parameterOffset: state.count }],
    };
  };
  query.interpolations.forEach((interpolation, interpolationIndex) => {
    const structural = parsed[interpolationIndex];
    const next: State[] = [];
    for (const state of states) {
      const staticSql = query.sql.slice(state.cursor, interpolation.sqlStart);
      const staticOffsets = query.sqlOffsetMap.slice(state.cursor, interpolation.sqlStart);
      const base: State = {
        ...state,
        sql: state.sql + staticSql,
        offsets: [...state.offsets, ...staticOffsets],
        cursor: interpolation.sqlEnd,
      };
      if (structural === undefined) {
        const marker = placeholder(base.count + 1);
        next.push({
          ...base,
          sql: base.sql + marker,
          offsets: [...base.offsets, ...Array.from({ length: marker.length }, () => interpolation.sourceStart)],
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
  return states.map((state) => {
    const tail = query.sql.slice(state.cursor);
    return {
      query: {
        ...query,
        sql: state.sql + tail,
        sqlOffsetMap: [...state.offsets, ...query.sqlOffsetMap.slice(state.cursor)],
        parameterCount: state.count,
      },
      choices: state.choices,
      fragments: state.fragments,
    };
  });
}

function conditionType(source: string, position: number, condition: string): string | undefined {
  const property = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(condition);
  if (property === null) return undefined;
  const prefix = source.slice(0, position);
  const parameter = new RegExp(`\\b${property[1]}\\s*:\\s*([A-Za-z_$][\\w$]*)`, "gu");
  let match: RegExpExecArray | null;
  let typeName: string | undefined;
  while ((match = parameter.exec(prefix)) !== null) typeName = match[1];
  return typeName === undefined ? undefined : `${typeName}[${JSON.stringify(property[2])}]`;
}

function structuralRowType(
  source: string,
  original: ExtractedQuery,
  rows: readonly { readonly row: string; readonly choices: ReadonlyMap<string, boolean> }[],
): string {
  const unique = [...new Set(rows.map((item) => item.row))];
  if (unique.length === 1) return unique[0] ?? "unknown";
  for (const condition of new Set(rows.flatMap((item) => [...item.choices.keys()]))) {
    const truthy = [...new Set(rows.filter((item) => item.choices.get(condition) === true).map((item) => item.row))];
    const falsy = [...new Set(rows.filter((item) => item.choices.get(condition) === false).map((item) => item.row))];
    const type = conditionType(source, original.range.start, condition);
    if (type !== undefined && truthy.length === 1 && falsy.length === 1 && truthy[0] !== falsy[0]) {
      return `${type} extends true ? ${truthy[0]} : ${type} extends false ? ${falsy[0]} : ${truthy[0]} | ${falsy[0]}`;
    }
  }
  return unique.join(" | ");
}

export function compileSource<Snapshot extends SchemaSnapshot, Policy>(
  options: CompileSourceOptions<Snapshot, Policy>,
): CompileSourceResult {
  const { source, dialect, schema } = options;
  if (schema.dialect !== dialect.id) {
    throw new TypeError(`Dialect ${dialect.id} cannot compile a ${schema.dialect} schema snapshot`);
  }
  const extracted = extractStaticQueries(source, (index) => dialect.placeholder(index), [dialect.sqlModule]);
  const compiled: CompiledQuery[] = [];
  const compiledFragments: CompiledFragment[] = [];
  const diagnostics: SqlDiagnostic[] = [];
  for (const query of extracted) {
    const variants = expandStructuralQuery(source, query, (index) => dialect.placeholder(index));
    if (variants !== undefined) {
      const resolvedVariants = variants.map((variant) => ({
        variant,
        resolved: dialect.analyze(variant.query.sql, schema, options.typePolicy),
      }));
      for (const { variant, resolved } of resolvedVariants) {
        diagnostics.push(...resolved.diagnostics.map((diagnostic) => mapDiagnostic(source, variant.query, diagnostic)));
      }
      if (!resolvedVariants.some(({ resolved }) => resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error"))) {
        const rows = resolvedVariants.map(({ variant, resolved }) => ({
          row: resolved.resultKind === "command" ? "never" : rowTypeLiteral(resolved.columns),
          choices: variant.choices,
        }));
        const parameterTypes = [...new Set(resolvedVariants.map(({ variant, resolved }) =>
          parameterTypeLiteral(variant.query.parameterCount, resolved.parameters)))];
        compiled.push({
          query,
          rowType: structuralRowType(source, query, rows),
          parameterType: parameterTypes.join(" | "),
          structural: true,
        });
        const byPosition = new Map<number, CompiledFragment>();
        for (const { variant, resolved } of resolvedVariants) {
          for (const item of variant.fragments) {
            const parameters = resolved.parameters
              .filter((parameter) => parameter.index > item.parameterOffset
                && parameter.index <= item.parameterOffset + item.query.parameterCount)
              .map((parameter): ResolvedParameter => ({ ...parameter, index: parameter.index - item.parameterOffset }));
            byPosition.set(item.query.insertionPosition, {
              fragment: item.query,
              parameterType: parameterTypeLiteral(item.query.parameterCount, parameters),
            });
          }
        }
        compiledFragments.push(...byPosition.values());
      }
      continue;
    }
    const resolved = dialect.analyze(query.sql, schema, options.typePolicy);
    diagnostics.push(...resolved.diagnostics.map((diagnostic) => mapDiagnostic(source, query, diagnostic)));
    if (!resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      compiled.push({
        query,
        rowType: resolved.resultKind === "command" ? "never" : rowTypeLiteral(resolved.columns),
        parameterType: parameterTypeLiteral(query.parameterCount, resolved.parameters),
      });
    }
  }
  const appendFragments = extractAppendFragments(
    source,
    (index) => dialect.placeholder(index),
    [dialect.sqlModule],
    extracted,
  );
  for (const { base, prefix, fragment, parameterOffset } of appendFragments) {
    const contextualSql = [base, ...prefix, fragment];
    const combined: ExtractedQuery = {
      ...base,
      sql: contextualSql.map((item) => item.sql).join(""),
      parameterCount: parameterOffset + fragment.parameterCount,
      range: { ...base.range, end: fragment.range.end },
      sqlOffsetMap: contextualSql.flatMap((item) => item.sqlOffsetMap),
    };
    const resolved = dialect.analyze(combined.sql, schema, options.typePolicy);
    const fragmentStart = combined.sql.length - fragment.sql.length;
    const fragmentDiagnostics = resolved.diagnostics.filter((diagnostic) => diagnostic.range.start >= fragmentStart);
    diagnostics.push(...fragmentDiagnostics.map((diagnostic) => mapDiagnostic(source, combined, diagnostic)));
    if (!resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      const parameters = resolved.parameters
        .filter((parameter) => parameter.index > parameterOffset)
        .map((parameter): ResolvedParameter => ({ ...parameter, index: parameter.index - parameterOffset }));
      compiledFragments.push({
        fragment,
        parameterType: parameterTypeLiteral(fragment.parameterCount, parameters),
      });
    }
  }
  let transformedSource = source;
  const insertions = [
    ...compiled.map((item) => ({
      position: item.query.insertionPosition,
      text: item.structural ? `.withRow<${item.rowType}>()` : `<${item.rowType}, ${item.parameterType}>`,
    })),
    ...compiledFragments.map((item) => ({
      position: item.fragment.insertionPosition,
      text: `<${item.parameterType}>`,
    })),
  ];
  for (const insertion of insertions.sort((left, right) => right.position - left.position)) {
    transformedSource = `${transformedSource.slice(0, insertion.position)}${insertion.text}${transformedSource.slice(insertion.position)}`;
  }
  return { transformedSource, queries: compiled, fragments: compiledFragments, diagnostics };
}
