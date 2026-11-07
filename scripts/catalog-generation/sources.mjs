import { fileURLToPath } from "node:url";
import { vendorSourceOwners } from "../../tools/grammar-catalog/src/sources/index.mjs";

const id = process.argv[2];
if (!id || process.argv.length !== 3) throw new Error("Usage: catalog:source <registered-owner>");
console.log(
  JSON.stringify(await vendorSourceOwners.get(id).refresh({ root: fileURLToPath(new URL("../../", import.meta.url)) })),
);
