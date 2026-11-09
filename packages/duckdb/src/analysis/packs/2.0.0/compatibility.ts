import { provenance } from "../../../catalog/core/2.0.0.js";
import { signatures } from "../../../catalog/packs/2.0.0.js";
import { registerDuckDBCompatibilityPack } from "../../../offline-packs.js";

/** Full existing offline evidence for the selected engine; never initializes a native SDK. */
export const duckdbCompatibilityPack = registerDuckDBCompatibilityPack("2.0.0", provenance.sourceDigest, signatures);
