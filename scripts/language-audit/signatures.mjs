import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { routineSignature } from "../../tools/grammar-catalog/src/model/routines.mjs";

export function signatureFacts(dialect, row, registry = builtinMappers) {
  return routineSignature(registry.get(dialect), row);
}
