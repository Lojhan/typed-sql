import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AnalysisConfiguration,
  createAnalysisContextScope,
  createProjectCatalog,
  createProjectCatalogClosure,
  createQueryContract,
  exportQueryContracts,
  type ProjectCatalogContribution,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import type { DialectProfile, QueryValuePlan, SchemaSnapshot } from "../../packages/core/src/index.js";

/** A contributed catalog changes the schema independently of every recorded query result. */
export async function installCatalogContractFixture(input: {
  readonly directory: string;
  readonly contractsDirectory: string;
  readonly profile: DialectProfile<SchemaSnapshot, unknown>;
  readonly schema: SchemaSnapshot;
  readonly configuration: AnalysisConfiguration;
  readonly queries: readonly { readonly sql: string; readonly valuePlan: QueryValuePlan }[];
}) {
  const { configuration, schema, profile } = input;
  const context = configuration.context;
  if (!context || schema.formatVersion !== 1) throw Error("The catalog fixture needs a pinned v1 base");
  const functions = {
    catalog_fixture: {
      name: "catalog_fixture",
      argumentTypes: [],
      returnType: "number",
      databaseReturnType: "integer",
      nullable: true,
    },
  };
  const owner: ProjectCatalogContribution<SchemaSnapshot, unknown> = {
    id: "fixture/catalog-owner",
    version: "1",
    grammar: context.grammar,
    apply(base) {
      return { ...base, functions };
    },
  };
  const projectCatalogs = createProjectCatalogClosure({
    schema,
    context,
    typePolicy: profile.defaultTypePolicy,
    catalogs: [
      createProjectCatalog({
        context,
        owner: { id: owner.id, version: owner.version },
        entries: [
          {
            kind: "fixture",
            identity: "fixture",
            permission: "fixed-result",
            evidenceDigest: queryContractDigest(functions),
            definition: functions,
          },
        ],
      }),
    ],
    contributions: [owner],
  });
  const cache = configuration.cache ?? {
    connectionContext: queryContractDigest("catalog-host-fixture"),
    adapter: { id: "fixture/catalog-native", version: "1" },
  };
  await exportQueryContracts(
    input.contractsDirectory,
    input.queries.map((query) =>
      createQueryContract({ ...query, context: projectCatalogs.context, origin: "offline-rule" }),
    ),
    {
      selection: {
        scope: createAnalysisContextScope({ profile, schema, configuration: { ...configuration, cache } }),
        context: projectCatalogs.context,
        projectCatalogs,
      },
    },
  );
  await writeFile(
    join(input.directory, "catalog-owner.mjs"),
    `export const contributions=[{id:${JSON.stringify(owner.id)},version:"1",grammar:${JSON.stringify(context.grammar)},apply(schema){return {...schema,functions:${JSON.stringify(functions)}};}}];`,
  );
  const configPath = join(input.directory, "typed-sql.config.mjs");
  await writeFile(
    configPath,
    (await readFile(configPath, "utf8")).replace(
      "analysis:{",
      `analysis:{cache:${JSON.stringify(cache)},projectCatalogs:{async loadContributions(){return (await import("./catalog-owner.mjs")).contributions;}},`,
    ),
  );
  return projectCatalogs;
}
