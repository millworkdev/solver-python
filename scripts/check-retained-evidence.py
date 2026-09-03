#!/usr/bin/env python3
"""Assert the retained verification evidence is complete, bound, and internally consistent."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "export-manifest.json").read_text())

parser = argparse.ArgumentParser()
parser.add_argument("--provenance", required=True, choices=["publish", "reverification"])
parser.add_argument("--evidence-dir", required=True, type=Path)
args = parser.parse_args()

identity = MANIFEST["identity"]
expected_hashes = {item["filename"]: item["sha256"] for item in MANIFEST["artifacts"]}
problems: list[str] = []
live_echo_states: dict[str, int] = {}

for python in MANIFEST["verification"]["clean_install_cpython"]:
    for kind in MANIFEST["verification"]["clean_install_artifact_kinds"]:
        name = f"python-{python}-{kind}.json"
        path = args.evidence_dir / name
        if not path.exists():
            problems.append(f"{name}: missing, so this runtime and artifact have no retained proof")
            continue
        try:
            record = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            problems.append(f"{name}: unreadable evidence ({error})")
            continue

        def wrong(label: str, actual: object, expected: object) -> None:
            problems.append(f"{name}: {label} is {actual!r}, expected {expected!r}")

        if record.get("schema_version") != 2:
            wrong("schema version", record.get("schema_version"), 2)
        if record.get("distribution") != identity["distribution"]:
            wrong("distribution", record.get("distribution"), identity["distribution"])
        if record.get("version") != identity["version"]:
            wrong("version", record.get("version"), identity["version"])
        # The file name claims a runtime and an artifact; the record has to agree.
        if record.get("python") != python:
            wrong("interpreter", record.get("python"), python)
        if record.get("installed_artifact_kind") != kind:
            wrong("installed artifact kind", record.get("installed_artifact_kind"), kind)
        if record.get("provenance") != args.provenance:
            wrong("provenance", record.get("provenance"), args.provenance)

        proof = record.get("credential_free_proof")
        if not isinstance(proof, dict) or not proof:
            problems.append(f"{name}: no credential-free proof recorded")
        elif not all(value is True for value in proof.values()):
            unproven = sorted(key for key, value in proof.items() if value is not True)
            problems.append(f"{name}: credential-free checks not proven: {', '.join(unproven)}")

        artifacts = record.get("registry_artifacts") or {}
        if set(artifacts) != set(expected_hashes):
            wrong("registry file inventory", sorted(artifacts), sorted(expected_hashes))
        for filename, expected_sha256 in expected_hashes.items():
            recorded = (artifacts.get(filename) or {}).get("sha256")
            if recorded != expected_sha256:
                problems.append(f"{name}: recorded {filename} hash {recorded} does not match the attested candidate")

        live_echo = record.get("live_echo") or {}
        status = live_echo.get("status")
        live_echo_states[str(status)] = live_echo_states.get(str(status), 0) + 1
        if status == "not_run" and not live_echo.get("reason"):
            problems.append(f"{name}: live Echo recorded as not run without a reason")
        elif status == "failed":
            problems.append(f"{name}: live Echo failed with exit code {live_echo.get('exit_code')}")
        elif status not in {"completed", "not_run"}:
            wrong("live Echo status", status, "completed, not_run, or failed")

if problems:
    for problem in problems:
        print(f"retained evidence problem: {problem}")
    raise SystemExit(f"retained {args.provenance} evidence is incomplete or inconsistent ({len(problems)} problems)")

expected_records = len(MANIFEST["verification"]["clean_install_cpython"]) * len(MANIFEST["verification"]["clean_install_artifact_kinds"])
summary = ", ".join(f"{count} {state}" for state, count in sorted(live_echo_states.items()))
print(f"{identity['distribution']}@{identity['version']} retained {args.provenance} evidence complete: {expected_records} records, live Echo {summary}")
