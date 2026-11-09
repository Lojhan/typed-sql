---
"@typed-sql/compiler": patch
---

Reuse the schema's table entries while matching manifest dependencies during compatibility analysis. Large query manifests avoid rebuilding the same table list for each relation and column reference.
