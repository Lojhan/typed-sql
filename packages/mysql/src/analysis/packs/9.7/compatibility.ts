import routines, { sourceRevision } from "../../../catalog/generated/packs/9.7.js";
import { registerMySqlCompatibilityPack } from "../../../offline-packs.js";
export const mysqlCompatibilityPack = registerMySqlCompatibilityPack("9.7", sourceRevision, routines);
