#!/usr/bin/env python3
"""Download, hash, clean-install, and Echo-test the exact PyPI release."""

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


parser = argparse.ArgumentParser()
parser.add_argument("--artifact-kind", required=True, choices=["wheel", "sdist"])
parser.add_argument("--evidence-id", required=True)
parser.add_argument("--out", required=True, type=Path)
args = parser.parse_args()

version = MANIFEST["identity"]["version"]
assert f"{sys.version_info.major}.{sys.version_info.minor}" in MANIFEST["identity"]["supported_cpython"]
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
    live = subprocess.run(
        [str(executable), str(ROOT / "scripts/live-echo.py")],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "MILLWORK_RELEASE_EVIDENCE_ID": args.evidence_id},
    )
    echo = json.loads(live.stdout)

proof = {
    "schema_version": 1,
    "distribution": MANIFEST["identity"]["distribution"],
    "version": version,
    "python": f"{sys.version_info.major}.{sys.version_info.minor}",
    "installed_artifact_kind": args.artifact_kind,
    "reviewed_export_sha": os.environ["EXPECTED_EXPORT_SHA"],
    "authorization_sha256": os.environ["AUTHORIZATION_SHA256"],
    "workflow_run_id": os.environ["GITHUB_RUN_ID"],
    "workflow_run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
    "registry_artifacts": downloaded,
    "sync_echo": echo["sync"],
    "async_echo": echo["async"],
    "result_content_expected": False,
}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
print(json.dumps(proof, sort_keys=True))
