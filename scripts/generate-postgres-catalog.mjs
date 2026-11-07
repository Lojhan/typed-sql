import { runCatalogCommand } from "./catalog-generation/run.mjs";

// Compatibility alias for the complete registered pipeline.
await runCatalogCommand(process.argv.includes("--check") ? "check" : "generate");
