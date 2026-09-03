#!/usr/bin/env python3
"""Verify the exact PyPI release: registry bytes and a clean install always, live Echo only when configured."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import venv


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "export-manifest.json").read_text())
# The live Echo proof needs both of these. This script never reads, prints, or
# records their values; it only observes whether the runner configured them, so
# that an unconfigured runner degrades to a recorded absence instead of
# destroying the registry-hash, clean-install, and installed-surface proofs.
LIVE_ECHO_CONFIGURATION_NAMES = ("SOLVERAPI_API_KEY", "SOLVERAPI_BASE_URL")
EXPECTED_SMOKE = {"sync_echo_shape": True, "async_echo_shape": True, "live_network_performed": False}


def download(url: str) -> bytes:
    parsed = urlparse(url)
    assert parsed.scheme == "https" and parsed.hostname == "files.pythonhosted.org", "artifact URL must use files.pythonhosted.org HTTPS"
    with urlopen(Request(url, headers={"Accept": "application/octet-stream"}), timeout=30) as response:
        assert response.geturl() == url, "artifact redirect forbidden"
        return response.read()


def registry_files(version: str) -> list[dict]:
    project = MANIFEST["identity"]["distribution"]
    url = f"https://pypi.org/pypi/{project}/{version}/json"
    deadline = time.monotonic() + 120
    while True:
        try:
            with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=30) as response:
                assert response.geturl() == url, "registry metadata redirect forbidden"
                assert response.headers.get_content_type() == "application/json"
                payload = json.load(response)
            break
        except HTTPError as error:
            if error.code != 404 or time.monotonic() >= deadline:
                raise
            time.sleep(2)
    assert payload["info"]["name"] == project
    assert payload["info"]["version"] == version
    return payload["urls"]


def python_in(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def absent_live_echo_configuration() -> list[str]:
    return sorted(name for name in LIVE_ECHO_CONFIGURATION_NAMES if not os.environ.get(name))


def run_live_echo(executable: Path, evidence_id: str) -> dict:
    """Call the live API from the clean-installed package, or record why it could not run.

    A failure is recorded and re-raised by the caller through the exit code: the
    evidence file is written first so a failed live call never also erases the
    credential-free proof that already succeeded.
    """
    absent = absent_live_echo_configuration()
    if absent:
        return {"status": "not_run", "reason": "credentials_absent", "absent_configuration": absent}
    try:
        live = subprocess.run(
            [str(executable), str(ROOT / "scripts/live-echo.py")],
            check=True,
            capture_output=True,
            text=True,
            env={**os.environ, "MILLWORK_RELEASE_EVIDENCE_ID": evidence_id},
        )
    except subprocess.CalledProcessError as error:
        # The captured output can carry API detail, so only the exit code is kept.
        return {"status": "failed", "reason": "live_echo_call_failed", "exit_code": error.returncode}
    echo = json.loads(live.stdout)
    return {"status": "completed", "sync": echo["sync"], "async": echo["async"]}


parser = argparse.ArgumentParser()
parser.add_argument("--artifact-kind", required=True, choices=["wheel", "sdist"])
parser.add_argument("--expected-python", required=True)
parser.add_argument("--provenance", required=True, choices=["publish", "reverification"])
parser.add_argument("--evidence-id", required=True)
parser.add_argument("--out", required=True, type=Path)
args = parser.parse_args()

version = MANIFEST["identity"]["version"]
running_python = f"{sys.version_info.major}.{sys.version_info.minor}"
# Binds the evidence file to the interpreter that actually produced it, so a
# skipped or misordered runtime setup cannot file one CPython's proof under
# another CPython's name.
assert running_python == args.expected_python, f"expected CPython {args.expected_python}, running {running_python}"
assert running_python in MANIFEST["identity"]["supported_cpython"]

# A publish run must record the reviewed export and authorization it ran under.
# A re-verification run has neither, and says so rather than inventing one.
reviewed_export_sha = os.environ["EXPECTED_EXPORT_SHA"] if args.provenance == "publish" else None
authorization_sha256 = os.environ["AUTHORIZATION_SHA256"] if args.provenance == "publish" else None

expected = {item["filename"]: item for item in MANIFEST["artifacts"]}
released = {item["filename"]: item for item in registry_files(version)}
assert set(released) == set(expected), "PyPI file inventory differs from the reviewed candidate"

with tempfile.TemporaryDirectory(prefix="millwork-release-") as temporary:
    directory = Path(temporary)
    downloaded = {}
    for filename, record in expected.items():
        registry = released[filename]
        assert registry["digests"]["sha256"] == record["sha256"], f"PyPI metadata hash drifted for {filename}"
        data = download(registry["url"])
        actual = hashlib.sha256(data).hexdigest()
        assert actual == record["sha256"], f"downloaded hash drifted for {filename}"
        path = directory / filename
        path.write_bytes(data)
        downloaded[filename] = {"sha256": actual, "url": registry["url"]}

    selected = next(item for item in MANIFEST["artifacts"] if item["kind"] == args.artifact_kind)
    environment = directory / "clean-install"
    venv.EnvBuilder(with_pip=True, clear=True).create(environment)
    executable = python_in(environment)
    subprocess.run(
        [str(executable), "-m", "pip", "install", "--disable-pip-version-check", str(directory / selected["filename"])],
        check=True,
    )
    smoke = subprocess.run(
        [str(executable), str(ROOT / "scripts/smoke-installed.py")],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(smoke.stdout) == EXPECTED_SMOKE, "installed public surface drifted"
    live_echo = run_live_echo(executable, args.evidence_id)

proof = {
    "schema_version": 2,
    "distribution": MANIFEST["identity"]["distribution"],
    "version": version,
    "python": running_python,
    "installed_artifact_kind": args.artifact_kind,
    "provenance": args.provenance,
    "evidence_id": args.evidence_id,
    "reviewed_export_sha": reviewed_export_sha,
    "authorization_sha256": authorization_sha256,
    "workflow_run_id": os.environ.get("GITHUB_RUN_ID"),
    "workflow_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    "registry_artifacts": downloaded,
    # Every entry below is written only on the far side of the assertion that
    # proves it, so the record cannot claim a check that did not pass.
    "credential_free_proof": {
        "registry_inventory_matches_candidate": True,
        "registry_metadata_hashes_match": True,
        "downloaded_artifact_hashes_match": True,
        "clean_install_completed": True,
        "installed_surface_smoke_completed": True,
    },
    "live_echo": live_echo,
    "result_content_expected": False,
}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
print(json.dumps(proof, sort_keys=True))
if live_echo["status"] == "failed":
    raise SystemExit(f"live Echo verification failed with exit code {live_echo['exit_code']}; evidence retained at {args.out}")
