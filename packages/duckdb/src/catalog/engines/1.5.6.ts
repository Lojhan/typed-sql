import { implicitCasts, signatures } from "../1.5.6.js";
import { commonTypes, expressionTypes } from "../common-1.5.6.js";
import { createDuckDBCatalog } from "../provider.js";

export const duckDBCatalog = createDuckDBCatalog({
  version: "1.5.6",
  signatures,
  implicitCasts,
  commonTypes,
  expressionTypes,
});
