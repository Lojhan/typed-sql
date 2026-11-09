---
"@typed-sql/mysql": patch
---

Preserve JSON parameter codecs and explicit JSON binding support when schema inputs use
uppercase or mixed-case JSON type names. Input shapes and wire representations continue to
follow the selected JSON policy.
