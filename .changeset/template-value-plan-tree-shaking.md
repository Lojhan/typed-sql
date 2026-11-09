---
"@typed-sql/compiler": patch
---

Allow bundlers to remove unused template value plans and conditional/repeated plan selectors
through application barrels. Validate generated metadata during compilation before annotating
its runtime constructor as pure. Application initialization effects remain observable, and invalid
descriptors fail before emission.
