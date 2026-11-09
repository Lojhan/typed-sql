import { provenance } from "../../../catalog/core/1.5.6.js";
import { signatures } from "../../../catalog/packs/1.5.6.js";
import { registerDuckDBCompatibilityPack } from "../../../offline-packs.js";

/** Full existing offline evidence for the selected engine; never initializes a native SDK. */
export const duckdbCompatibilityPack = registerDuckDBCompatibilityPack("1.5.6", provenance.sourceDigest, signatures);
