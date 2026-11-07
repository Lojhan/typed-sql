#!/usr/bin/env python3
"""Measure the tracked baseline used by the grammar completeness specification."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DIALECTS = ("postgres", "mysql", "sqlite", "sqlserver", "duckdb")


def group(path):
    for dialect in DIALECTS:
        prefix = f"packages/{dialect}/src/"
        if path.startswith(prefix) and path.endswith(".ts"):
            relative = path[len(prefix):]
            if "/generated/" in path or ".generated." in path:
                return "generated_product_ts", dialect, "generated"
            if relative.startswith("parser/"):
                area = "parser"
            elif relative.startswith("catalog/"):
                area = "catalog"
            elif relative in ("resolver.ts", "semantics.ts", "type-policy.ts", "type-resolution.ts", "native-types.ts", "decoding.ts", "codecs.ts", "expression-evidence.ts"):
                area = "resolution_types_codecs"
            else:
                area = "other_product"
            return "maintained_product_ts", dialect, area
        if path.startswith(f"packages/{dialect}/test/") and path.endswith((".ts", ".mjs")):
            return "maintained_tests", dialect, "tests"
    if path.startswith("grammar/"):
        if path.endswith(("/core.json", "/policy.json")):
            return "maintained_policy_json", path.split("/")[1], "policy"
        if path == "grammar/catalog/upstream.json" or "/combinations-" in path:
            return "captured_fact_json", None, "capture"
        if path == "grammar/catalog/generation.json":
            return "derived_manifest_json", None, "manifest"
        return "other_grammar_json", None, "other"
    if ((path.startswith(("scripts/catalog-generation/", "scripts/language-audit/")) and path.endswith((".ts", ".mjs"))) or path in ("scripts/generate-postgres-catalog.mjs", "scripts/generate-mysql-catalog.mjs")):
        return "maintained_generation_audit_tooling", None, "tooling"
    if path in ("test/contracts/catalog-generation.test.ts", "test/contracts/language-audit.test.ts"):
        return "maintained_tests", "contracts", "tests"
    if path.startswith("test/fixtures/language-audit/") and path.endswith(".json"):
        return "reference_evidence_fixture_json", None, "reference_evidence"
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default="HEAD")
    args = parser.parse_args()
    revision = subprocess.check_output(["git", "rev-parse", "--verify", args.revision], cwd=ROOT).decode().strip()
    paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "-z", revision], cwd=ROOT).decode().split("\0")
    selected = [(path, group(path)) for path in paths if group(path)]
    requests = "".join(f"{revision}:{path}\n" for path, _ in selected).encode()
    objects = BytesIO(subprocess.run(["git", "cat-file", "--batch"], cwd=ROOT, input=requests, stdout=subprocess.PIPE, check=True).stdout)
    files = []
    for path, classification in selected:
        header = objects.readline().decode().split()
        if len(header) != 3 or header[1] != "blob":
            raise ValueError(f"Cannot measure git blob: {path}")
        data = objects.read(int(header[2]))
        if objects.read(1) != b"\n":
            raise ValueError(f"Invalid git blob boundary: {path}")
        lines = data.decode().splitlines()
        category, dialect, area = classification
        row = dict(path=path, category=category, dialect=dialect, area=area,
                   physical_lines=len(lines), nonblank_lines=sum(bool(line.strip()) for line in lines), bytes=len(data))
        if path.endswith(".json"):
            row["compact_json_bytes"] = len(json.dumps(json.loads(data), separators=(",", ":"), ensure_ascii=False).encode())
        files.append(row)
    totals = {}
    for row in files:
        bucket = totals.setdefault(row["category"], dict(files=0, physical_lines=0, nonblank_lines=0, bytes=0))
        bucket["files"] += 1
        for field in ("physical_lines", "nonblank_lines", "bytes"):
            bucket[field] += row[field]
    report = dict(
        revision=revision,
        method="Git blobs from the named revision only; physical lines include comments and blanks; nonblank lines are not semantic SLOC. Mutually exclusive categories. Tests include five grammar packages and two audit/generation contracts. Audit JSON references/baselines are evidence fixtures, not maintained test code. Worktree changes, dependencies, build outputs and this planning document are excluded.",
        totals=totals, files=files)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
