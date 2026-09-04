---
"@typed-sql/schema": minor
"@typed-sql/cli": patch
---

Stage serialized artifacts in sibling files before atomic replacement, preserving existing file permissions and cleaning staging files on failure. Schema generation publishes its self-contained JSON input last. Individual files are atomic; publication across files is not a filesystem transaction.
