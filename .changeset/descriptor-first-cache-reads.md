---
"@typed-sql/analysis": patch
---

Open recorded cache and artifact files through a no-follow descriptor before validating their
regular-file identity. Reads use that descriptor and reject replaced paths, symbolic links,
nonregular files, excessive sizes and invalid UTF-8.
