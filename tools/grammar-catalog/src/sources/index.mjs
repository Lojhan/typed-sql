import { createMapperRegistry } from "../registry.mjs";
import { refreshSQLiteSources } from "./sqlite/refresh.mjs";
export const vendorSourceOwners = createMapperRegistry([{ id: "sqlite", refresh: refreshSQLiteSources }], {
  methods: ["refresh"],
});
