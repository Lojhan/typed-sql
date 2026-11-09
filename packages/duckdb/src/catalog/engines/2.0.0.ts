import { implicitCasts, signatures } from "../2.0.0.js";
import { commonTypes, expressionTypes } from "../common-2.0.0.js";
import { createDuckDBCatalog } from "../provider.js";

export const duckDBCatalog = createDuckDBCatalog({
  version: "2.0.0",
  signatures,
  implicitCasts,
  commonTypes,
  expressionTypes,
});
