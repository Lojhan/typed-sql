---
"@typed-sql/sqlite": minor
---

Graduate the SQLite grammar and optional `node:sqlite` adapter to the stable release track. The
stable contract covers SQLite 3.39.0 through 3.53.4, keeps unknown newer libraries conservative,
and verifies the adapter on Node 22.13+, 24, and 26 while leaving the driver-neutral grammar usable
on typed-sql's general Node.js range.
