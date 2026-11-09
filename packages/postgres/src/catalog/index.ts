import { POSTGRES_SUPPORT_POLICY } from "../support.js";
import catalog14 from "./generated/14.js";
import catalog15 from "./generated/15.js";
import catalog16 from "./generated/16.js";
import catalog17 from "./generated/17.js";
import catalog18 from "./generated/18.js";
import catalog19 from "./generated/19.js";
import { createPostgresCatalogProvider } from "./provider.js";

export type {
  PostgresCastContext,
  PostgresCastMethod,
  PostgresCatalogCast,
  PostgresCatalogOperatorFamily,
  PostgresCatalogRoutineFamily,
  PostgresCatalogTableRoutineFamily,
  PostgresCatalogType,
  PostgresCatalogTypeMapping,
  PostgresCoreCatalog,
  PostgresOperatorResultRule,
  PostgresRoutineResultRule,
  PostgresTableRoutineResultRule,
  PostgresTypeCategory,
} from "./types.js";

export const POSTGRES_CORE_CATALOG_FORMAT_VERSION = 1 as const;

export const postgresCatalogProvider = createPostgresCatalogProvider(
  [catalog14, catalog15, catalog16, catalog17, catalog18, catalog19],
  POSTGRES_SUPPORT_POLICY.stableMajors[0],
);

export const {
  catalog: postgresCoreCatalog,
  forSchema: postgresCoreCatalogForSchema,
  typeMapping: postgresCatalogTypeMapping,
  type: postgresCatalogType,
  cast: postgresCatalogCast,
  canCast: postgresCatalogCanCast,
  operatorRule: postgresCatalogOperatorRule,
  routineRule: postgresCatalogRoutineRule,
  tableRoutineRule: postgresCatalogTableRoutineRule,
} = postgresCatalogProvider;
