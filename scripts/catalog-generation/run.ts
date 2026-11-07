import { runCatalogCommand } from "./run.mjs";

// Compatibility entrypoint. Generation itself needs no TypeScript loader or grammar runtime.
await runCatalogCommand(process.argv[2], process.argv.slice(3));
