import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  DEFAULT_MAX_QUERY_PARAMETERS,
  DEFAULT_MAX_RENDERED_SQL_BYTES,
  type Query,
  renderQuery,
  type SqlRenderer,
  type SqlSegment,
} from "./query.js";
import { defineQueryValuePlan, QueryValueError, type QueryValuePlan } from "./query-value-plan.js";
import { utf8ByteLength } from "./utf8.js";

/** Compiler-owned repetition evidence; SQL syntax and placeholders come from the grammar. */
export interface RepeatedQueryValuePlan {
  readonly listIndex: number;
  readonly elementSql: string;
  readonly separatorSql: string;
  readonly parameterOffset: number;
  readonly parameterCount: number;
  readonly representativeItems: 1 | 2;
}

export interface QueryValuePlanChoice {
  readonly sql: string;
  readonly plan: QueryValuePlan;
  readonly repeated?: readonly RepeatedQueryValuePlan[];
}
export type QueryValuePlanSelector = <Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
) => QueryValuePlan;
type List = Extract<SqlSegment, { readonly kind: "fragment-list" }>;

function parameterKey(parameter: QueryValuePlan["parameters"][number]): string {
  const { index: _index, ...descriptor } = parameter;
  return JSON.stringify(descriptor);
}

/** Match actual rendered structure without parsing SQL or retaining invocation values. */
export function defineQueryValuePlanSelector(
  renderer: SqlRenderer,
  input: readonly QueryValuePlanChoice[],
): QueryValuePlanSelector {
  if (input.length === 0 || input.length > DEFAULT_MAX_QUERY_PARAMETERS)
    throw new TypeError("Runtime value plan choices must be nonempty");
  let bytes = 0;
  const seen = new Set<string>();
  const choices = input.map((choice) => {
    if (typeof choice.sql !== "string" || !choice.sql || seen.has(choice.sql))
      throw new TypeError("Invalid duplicate SQL plan choice");
    seen.add(choice.sql);
    bytes += utf8ByteLength(choice.sql);
    if (bytes > DEFAULT_MAX_RENDERED_SQL_BYTES)
      throw new TypeError("Runtime value plan SQL evidence exceeds size limit");
    const plan = defineQueryValuePlan(choice.plan);
    let end = 0;
    let listIndex = -1;
    const repeated = (choice.repeated ?? []).map((site) => {
      if (
        !Number.isSafeInteger(site.listIndex) ||
        site.listIndex <= listIndex ||
        !Number.isSafeInteger(site.parameterOffset) ||
        site.parameterOffset < end ||
        !Number.isSafeInteger(site.parameterCount) ||
        site.parameterCount < 0 ||
        (site.representativeItems !== 1 && site.representativeItems !== 2) ||
        typeof site.elementSql !== "string" ||
        typeof site.separatorSql !== "string"
      )
        throw new TypeError("Invalid repeated value plan evidence");
      listIndex = site.listIndex;
      end = site.parameterOffset + site.parameterCount * site.representativeItems;
      if (end > plan.parameters.length) throw new TypeError("Repeated value plan parameters exceed their plan");
      for (let offset = 0; offset < site.parameterCount; offset++) {
        const descriptor = parameterKey(plan.parameters[site.parameterOffset + offset]!);
        for (let item = 1; item < site.representativeItems; item++) {
          if (parameterKey(plan.parameters[site.parameterOffset + item * site.parameterCount + offset]!) !== descriptor)
            throw new TypeError("Repeated value plan parameters have incompatible contexts");
        }
      }
      bytes += utf8ByteLength(site.elementSql) + utf8ByteLength(site.separatorSql);
      return Object.freeze({ ...site });
    });
    return { sql: choice.sql, plan, repeated, cache: new Map<string, QueryValuePlan>() };
  });
  if (bytes > DEFAULT_MAX_RENDERED_SQL_BYTES) throw new TypeError("Runtime value plan SQL evidence exceeds size limit");

  return (query) => {
    const actual = renderQuery(query, renderer);
    const lists = query.segments.filter((segment): segment is List => segment.kind === "fragment-list");
    for (const choice of choices) {
      if (choice.repeated.length === 0) {
        if (actual.text === choice.sql && actual.values.length === choice.plan.parameters.length) return choice.plan;
        continue;
      }
      const replacements = new Map<List, List>();
      const counts: number[] = [];
      let parameterCount = choice.plan.parameters.length;
      let matches = true;
      for (const site of choice.repeated) {
        const list = lists[site.listIndex];
        if (
          list === undefined ||
          list.items.length === 0 ||
          renderQuery({ ...query, segments: list.separator.segments }, renderer).text !== site.separatorSql
        ) {
          matches = false;
          break;
        }
        for (const item of list.items) {
          if (
            item.segments.some((segment) => segment.kind === "fragment-list") ||
            renderQuery({ ...query, segments: item.segments }, renderer).text !== site.elementSql
          ) {
            matches = false;
            break;
          }
        }
        if (!matches) break;
        counts.push(list.items.length);
        parameterCount += (list.items.length - site.representativeItems) * site.parameterCount;
        replacements.set(list, {
          ...list,
          items: Array.from({ length: site.representativeItems }, () => list.items[0]!),
        });
      }
      if (!matches || parameterCount > DEFAULT_MAX_QUERY_PARAMETERS || parameterCount !== actual.values.length)
        continue;
      const representative = {
        ...query,
        segments: query.segments.map((segment) =>
          segment.kind === "fragment-list" ? (replacements.get(segment) ?? segment) : segment,
        ),
      };
      if (renderQuery(representative, renderer).text !== choice.sql) continue;
      const key = counts.join(",");
      const cached = choice.cache.get(key);
      if (cached !== undefined) {
        choice.cache.delete(key);
        choice.cache.set(key, cached);
        return cached;
      }
      const parameters: QueryValuePlan["parameters"][number][] = [];
      let cursor = 0;
      for (let siteIndex = 0; siteIndex < choice.repeated.length; siteIndex++) {
        const site = choice.repeated[siteIndex]!;
        parameters.push(...choice.plan.parameters.slice(cursor, site.parameterOffset));
        const pattern = choice.plan.parameters.slice(site.parameterOffset, site.parameterOffset + site.parameterCount);
        for (let item = 0; item < counts[siteIndex]!; item++) parameters.push(...pattern);
        cursor = site.parameterOffset + site.parameterCount * site.representativeItems;
      }
      parameters.push(...choice.plan.parameters.slice(cursor));
      const plan = defineQueryValuePlan({
        ...choice.plan,
        parameters: parameters.map((parameter, index) => ({ ...parameter, index: index + 1 })),
      });
      choice.cache.set(key, plan);
      if (choice.cache.size > DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS)
        choice.cache.delete(choice.cache.keys().next().value!);
      return plan;
    }
    throw new QueryValueError("plan", "SQL structure does not match any compiled value plan");
  };
}
