import {
  canonicalContractData,
  createContractDialect,
  createQueryContract,
  type QueryContractContext,
} from "@typed-sql/analysis";
import { buildQueryValuePlan } from "@typed-sql/compiler";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";

/** Materialize only what the installed owner and the portable contract model preserve exactly. */
export function materializeOfflineContract<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly sql: string;
  readonly context: QueryContractContext;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy: Policy;
  readonly parameterCount: number;
}) {
  const { sql, context, dialect, schema, typePolicy } = input;
  const analysis = dialect.analyze(sql, schema, typePolicy, { runtimeValidation: true });
  const failure = analysis.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (failure)
    throw new Error(
      `Offline contract generation requires successful grammar analysis: ${failure.code}: ${failure.message}`,
    );
  if ([...analysis.columns, ...analysis.parameters].some((field) => field.databaseTypeIsPartial))
    throw new Error(
      "Offline contract generation cannot yet preserve partial native type identity; acquire a qualified native contract",
    );
  const contract = createQueryContract({
    sql,
    context,
    origin: "offline-rule",
    valuePlan: buildQueryValuePlan(dialect, analysis, typePolicy, input.parameterCount),
    columnSpans: analysis.columns.map(({ range }) => ({ start: range.start, end: range.end })),
    ...(analysis.resultKind === undefined ? {} : { resultKind: analysis.resultKind }),
  });
  const { analyze: _analyze, ...profile } = dialect;
  const projected = createContractDialect({ profile, context, contracts: [contract] }).analyze(sql, schema, typePolicy);
  const fields = (value: typeof analysis) => ({
    resultKind: value.resultKind ?? "unknown",
    columns: value.columns.map(({ name, tsType, nullable, databaseType, json, scalarJsonShape }) => ({
      name,
      tsType,
      nullable,
      databaseType: databaseType ?? null,
      json: json ?? null,
      scalarJsonShape: scalarJsonShape ?? null,
    })),
    parameters: value.parameters.map(({ index, tsType, nullable, databaseType, json, acceptsJsonInput }) => ({
      index,
      tsType,
      nullable,
      databaseType: databaseType ?? null,
      json: json ?? null,
      acceptsJsonInput: acceptsJsonInput ?? false,
    })),
  });
  if (
    projected.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    canonicalContractData(fields(analysis)) !== canonicalContractData(fields(projected))
  )
    throw new Error(
      "Offline contract generation cannot preserve this query's logical types; acquire a qualified native contract",
    );
  return contract;
}
