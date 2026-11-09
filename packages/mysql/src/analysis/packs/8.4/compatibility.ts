import routines, { sourceRevision } from "../../../catalog/generated/packs/8.4.js";
import { registerMySqlCompatibilityPack } from "../../../offline-packs.js";
export const mysqlCompatibilityPack = registerMySqlCompatibilityPack("8.4", sourceRevision, routines);
