---
"@typed-sql/compiler": patch
---

Keep SQL module type dependencies present when SQL is invalid, reducing directory watch churn during quick corrections in the experimental native TypeScript watcher. Invalid queries continue to report diagnostics and resolve to `never`.
