---
"@typed-sql/mysql": minor
---

Add selected-series analyzers and bounded offline cores. Each core retains all existing maintained
routine families, types, coercions, operators, collations and JSON rules without loading other
full series catalogs or introspection services. Unmapped routines preserve parameter evidence
and request a qualified query contract. Version, edition, SQL-mode and ambiguity errors remain
blocking. Existing analyzer imports preserve their offline behavior and diagnostic compatibility;
canary selection retains the existing explicit version policy.
