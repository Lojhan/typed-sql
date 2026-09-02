# Retained fuzz regressions

`corpus.ts` is the reviewed, deterministic seed and regression inventory shared by package tests.

When fuzzing discovers a defect:

1. minimize the input while preserving the same failure;
2. add a uniquely named regression with the affected targets and reason;
3. add or tighten the owning package assertion if deterministic replay alone does not express the bug;
4. run `pnpm fuzz:replay` before closing the defect.

Do not replace a regression with a random seed. Seeds expand exploration; the minimized fixture makes
the exact failure permanent and reviewable.
