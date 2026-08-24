# MySQL end-to-end fixture

Run `pnpm e2e:mysql` from the repository root. The suite builds the digest-pinned official MySQL 8.4 image, introspects its real catalog, generates the developer package, verifies TypeScript 7 types and editor hover types, executes with the application-owned `mysql2` driver, checks drift, and removes its container.
