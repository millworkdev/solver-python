#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseBinding } from "./authorization-payload.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256Pattern = /^[0-9a-f]{64}$/;
const fullShaPattern = /^[0-9a-f]{40}$/;
const expectedRootKeys = [
  "artifacts",
  "candidate_evidence",
  "files",
  "identity",
  "manifest_id",
  "publication",
  "repository",
  "schema_version",
  "status",
  "verification",
  "workflow_binding",
];
const expectedArtifactFiles = [
  "millwork_solver-0.1.0-py3-none-any.whl",
  "millwork_solver-0.1.0.tar.gz",
];
const expectedRepositorySupportOverlay = [
  ".github/repository-description.txt",
  "SECURITY.md",
  "SUPPORT.md",
];
const expectedArtifactBindings = {
  "millwork_solver-0.1.0-py3-none-any.whl": {
    kind: "wheel",
    sha256: "e177ec7ca91edcb7f1db5f87ccfdae6d4eb3b17d0d7c3047015ad2af694bd3a7",
    size_bytes: 68530,
  },
  "millwork_solver-0.1.0.tar.gz": {
    kind: "sdist",
    sha256: "bf8652181e49cbb407bf8dc59ce638e49f7ba8e268619df677cd4621021530e7",
    size_bytes: 15177,
  },
};
const expectedPublicationKeys = [
  "credential_used",
  "environment_configured",
  "external_mutation_performed",
  "project_created",
  "published",
  "trusted_publisher_configured",
  "workflow_dispatched",
];
const expectedWorkflow = {
  authorization_actions: ["publish_retained_artifacts", "verify_published_artifacts"],
  authorization_max_lifetime_seconds: 86400,
  authorization_payload_schema: "millworkdev.solver-python.bounded-publish-authorization.v1",
  environment: "pypi-publish",
  path: ".github/workflows/publish.yml",
  publish_action: "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
  runner: "ubuntu-24.04",
};

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).toSorted(), [...expected].toSorted(), `${label} keys drifted`);
}

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue;
    const absolute = resolve(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = lstatSync(absolute);
    assert.equal(stat.isSymbolicLink(), false, `symbolic link forbidden: ${relativePath}`);
    if (entry.isDirectory()) files.push(...listFiles(absolute, relativePath));
    else {
      assert.equal(entry.isFile(), true, `special file forbidden: ${relativePath}`);
      files.push(relativePath);
    }
  }
  return files;
}

function scanPublicText(paths, root) {
  const binary = new Set(expectedArtifactFiles.map((name) => `dist/${name}`));
  const privateCoordinate = "matt783" + "/solverAPI";
  const internalIssueMarker = "#" + "501";
  const internalRowMarker = "P" + "Y5";
  const timeSensitiveRegistryProse = new RegExp(
    `\\b(?:${["not on", "PyPI"].join(" ")}|${["not available from", "PyPI"].join(" ")}|${["not available on", "PyPI"].join(" ")}|${["unpublished", "candidate"].join(" ")}|${["local, attested", "candidate"].join(" ")})\\b`,
    "i",
  );
  const secretPatterns = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/AKIA[0-9A-Z]{16}/, "AWS access key"],
    [/ghp_[A-Za-z0-9]{36,}/, "GitHub token"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub PAT"],
    [/sk_live_[A-Za-z0-9]+/, "Stripe live key"],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
    [/postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/i, "Postgres URL with password"],
    [/npm_[A-Za-z0-9]{36,}/, "npm token"],
    [/pypi-AgEI[A-Za-z0-9_-]{20,}/, "PyPI token"],
  ];
  const sensitiveMaterialPatterns = [
    [/\b(?:customer|provider)[_-](?:account|tenant|organization|project|user)_id\s*[:=]\s*["']?[A-Za-z0-9_-]{4,}/i, "provider/customer identifier"],
    [/\b(?:customer|provider)[_-](?:email|name)\s*[:=]\s*["'][^"'\r\n]+["']/i, "provider/customer identity"],
  ];
  for (const path of paths) {
    if (binary.has(path)) continue;
    const text = readFileSync(resolve(root, path), "utf8");
    assert.equal(text.includes(privateCoordinate), false, `private coordinate forbidden: ${path}`);
    assert.equal(text.includes(internalIssueMarker), false, `internal issue marker forbidden: ${path}`);
    assert.equal(text.includes(internalRowMarker), false, `internal row marker forbidden: ${path}`);
    assert.doesNotMatch(text, /\b(?:PY\d+|(?:F|T|M|G|PUB|SH)-?\d+)(?:-[A-Z0-9]+)?\b/, `internal work-row identifier forbidden: ${path}`);
    assert.doesNotMatch(text, /#\d+\b/, `internal issue shorthand forbidden: ${path}`);
    assert.doesNotMatch(text, /(?:contracts\/developer-experience|scope\/)/, `internal source path forbidden: ${path}`);
    assert.doesNotMatch(text, timeSensitiveRegistryProse, `time-sensitive registry prose forbidden: ${path}`);
    assert.doesNotMatch(text, /\/(?:Users|home|private\/tmp)\//, `absolute private path forbidden: ${path}`);
    for (const [pattern, label] of secretPatterns) {
      assert.doesNotMatch(text, pattern, `${label} forbidden: ${path}`);
    }
    for (const [pattern, label] of sensitiveMaterialPatterns) {
      assert.doesNotMatch(text, pattern, `${label} forbidden: ${path}`);
    }
  }
}

export function validateExport(root = repositoryRoot) {
  const manifestPath = resolve(root, "export-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  exactKeys(manifest, expectedRootKeys, "export manifest");
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.manifest_id, "millworkdev.solver-python.publish-preparation.v1");
  assert.equal(manifest.status, "prepared_not_authorized");
  assert.deepEqual(manifest.repository, {
    coordinate: "millworkdev/solver-python",
    visibility: "public",
    default_branch: "main",
  });
  assert.deepEqual(manifest.identity, {
    distribution: "millwork-solver",
    import_package: "millwork_solver",
    version: "0.1.0",
    license: "Apache-2.0",
    supported_cpython: ["3.11", "3.12", "3.13", "3.14"],
  }, "identity drifted");
  assert.deepEqual(manifest.workflow_binding, expectedWorkflow, "workflow binding drifted");
  exactKeys(manifest.publication, expectedPublicationKeys, "publication facts");
  assert.equal(Object.values(manifest.publication).every((value) => value === false), true, "publication facts must remain false");

  assert.deepEqual(manifest.artifacts.map((item) => item.filename), expectedArtifactFiles);
  for (const artifact of manifest.artifacts) {
    exactKeys(artifact, ["filename", "kind", "sha256", "size_bytes"], `${artifact.filename} record`);
    assert.deepEqual(
      { kind: artifact.kind, sha256: artifact.sha256, size_bytes: artifact.size_bytes },
      expectedArtifactBindings[artifact.filename],
      `${artifact.filename} exact retained binding drifted`,
    );
    assert.match(artifact.sha256, sha256Pattern);
    const bytes = readFileSync(resolve(root, "dist", artifact.filename));
    assert.equal(bytes.length, artifact.size_bytes, `${artifact.filename} size drifted`);
    assert.equal(digest(bytes), artifact.sha256, `${artifact.filename} hash drifted`);
  }
  const privateSourceBridge = JSON.parse(readFileSync(resolve(root, "publish-binding.json"), "utf8"));
  validateReleaseBinding(privateSourceBridge, manifest.artifacts, { requireReady: false });
  exactKeys(manifest.candidate_evidence, [
    "behavior_drift_validated",
    "operation_snapshot_sha256",
    "packet_sha256",
    "status",
    "supply_chain_checks_passed",
  ], "candidate evidence");
  assert.equal(manifest.candidate_evidence.status, "READY");
  assert.equal(manifest.candidate_evidence.behavior_drift_validated, true);
  assert.equal(manifest.candidate_evidence.supply_chain_checks_passed, true);
  assert.match(manifest.candidate_evidence.packet_sha256, sha256Pattern);
  assert.match(manifest.candidate_evidence.operation_snapshot_sha256, sha256Pattern);
  assert.deepEqual(manifest.verification, {
    registry_hash_comparison_required: true,
    clean_install_artifact_kinds: ["wheel", "sdist"],
    clean_install_cpython: ["3.11", "3.12", "3.13", "3.14"],
    installed_surface_smoke_required: true,
    sync_echo_required: true,
    async_echo_required: true,
    live_echo_requires_credentials: true,
    live_echo_absence_must_be_recorded: true,
    evidence_retained_after_upload: true,
    result_content_expected: false,
  });

  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "manifest files are required");
  const manifestPaths = manifest.files.map((entry) => entry.path);
  assert.deepEqual(manifestPaths, [...manifestPaths].toSorted((a, b) => a.localeCompare(b)), "manifest files must be lexical");
  assert.equal(new Set(manifestPaths).size, manifestPaths.length, "manifest files must be unique");
  const actualPaths = listFiles(root);
  assert.deepEqual(
    actualPaths,
    [
      "export-manifest.json",
      ...manifestPaths,
      ...expectedRepositorySupportOverlay,
    ].toSorted((a, b) => a.localeCompare(b)),
    "public export inventory drifted",
  );
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "sha256", "size_bytes"], `${entry.path} file record`);
    assert.match(entry.sha256, sha256Pattern);
    const bytes = readFileSync(resolve(root, entry.path));
    assert.equal(bytes.length, entry.size_bytes, `${entry.path} size drifted`);
    assert.equal(digest(bytes), entry.sha256, `${entry.path} hash drifted`);
  }
  scanPublicText(actualPaths, root);

  const publishWorkflow = readFileSync(resolve(root, expectedWorkflow.path), "utf8");
  for (const match of publishWorkflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    const reference = match[1].split("@")[1] ?? "";
    assert.match(reference, fullShaPattern, `action must be pinned to a full SHA: ${match[1]}`);
  }
  assert.match(publishWorkflow, /workflow_dispatch:/);
  assert.match(publishWorkflow, /environment: pypi-publish/);
  assert.match(publishWorkflow, /runs-on: ubuntu-24\.04/);
  assert.match(publishWorkflow, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.match(publishWorkflow, new RegExp(expectedWorkflow.publish_action.replaceAll("/", "\\/")));
  assert.doesNotMatch(publishWorkflow, /(?:python\s+-m\s+build|pip\s+wheel|\bbuild\s+--)/i, "publish workflow must not rebuild");
  assert.doesNotMatch(publishWorkflow, /(?:PYPI_API_TOKEN|TWINE_PASSWORD|password:)/, "publish workflow must not use a token");
  assert.equal((publishWorkflow.match(/uses: actions\/setup-python@/g) ?? []).length, 4, "publish workflow must verify exactly four CPython runtimes");
  for (const version of ["3.11", "3.12", "3.13", "3.14"]) {
    assert.equal((publishWorkflow.match(new RegExp(`python-version: "${version.replace(".", "\\.")}"`, "g")) ?? []).length, 1, `publish workflow CPython ${version} drifted`);
    for (const kind of ["wheel", "sdist"]) {
      assert.match(publishWorkflow, new RegExp(`--artifact-kind ${kind}[^\\n]+-${version.replace(".", "\\.")}-${kind}`), `post-publish ${version}/${kind} verification drifted`);
      assert.match(
        publishWorkflow,
        new RegExp(`--expected-python ${version.replace(".", "\\.")} --provenance publish[^\\n]+-${version.replace(".", "\\.")}-${kind}`),
        `post-publish ${version}/${kind} evidence must be bound to the interpreter that produced it`,
      );
    }
  }
  // Once the registry holds the bytes, neither the remaining runtimes nor the
  // evidence upload may be skipped by an earlier verification failure.
  assert.match(publishWorkflow, /id: upload/, "the upload step must be addressable by the verification guards");
  assert.equal(
    (publishWorkflow.match(/if: \$\{\{ !cancelled\(\) && steps\.upload\.outcome == 'success' \}\}/g) ?? []).length,
    9,
    "every post-publish runtime and the evidence upload must survive an earlier verification failure",
  );
  // Within a runtime, the wheel and source-distribution proofs must both run.
  // The runner executes a `run:` block under errexit, so an intolerant first
  // call would abandon the second artifact's credential-free record entirely.
  assert.equal((publishWorkflow.match(/ \|\| status=\$\?$/gm) ?? []).length, 8, "both artifact proofs must run in every post-publish runtime");
  assert.equal((publishWorkflow.match(/^\s+exit "\$status"$/gm) ?? []).length, 4, "every post-publish runtime must still propagate its failure");
  const verifier = readFileSync(resolve(root, "scripts/verify-published-release.py"), "utf8");
  assert.match(verifier, /files\.pythonhosted\.org/, "registry artifact host guard missing");
  assert.match(verifier, /reviewed_export_sha/, "reviewed export SHA evidence missing");
  assert.match(verifier, /authorization_sha256/, "authorization evidence missing");
  assert.match(verifier, /live-echo\.py/, "installed live Echo verification missing");
  assert.doesNotMatch(verifier, /--no-deps/, "post-publish install must include the resolved dependency graph");
  assert.match(verifier, /smoke-installed\.py/, "credential-free installed-surface smoke missing");
  assert.match(verifier, /credentials_absent/, "an unconfigured live Echo must be recorded, never assumed");
  assert.match(verifier, /not_run/, "a live Echo that did not happen must be recorded as not run");
  assert.match(verifier, /--provenance/, "publish and re-verification evidence must be distinguishable");
  const liveEcho = readFileSync(resolve(root, "scripts/live-echo.py"), "utf8");
  assert.match(liveEcho, /getExecutionsByExecutionId/, "Echo terminal polling missing");
  assert.match(liveEcho, /getReceiptsByExecutionId/, "Echo receipt retrieval missing");
  assert.doesNotMatch(liveEcho, /getExecutionsByExecutionIdResult/, "Echo must not request result content");
  // The re-verification workflow re-proves everything that needs no credential.
  // It must never gain the ability to publish or to reach the live API.
  const verifyWorkflow = readFileSync(resolve(root, ".github/workflows/verify-release.yml"), "utf8");
  for (const match of verifyWorkflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    const reference = match[1].split("@")[1] ?? "";
    assert.match(reference, fullShaPattern, `action must be pinned to a full SHA: ${match[1]}`);
  }
  assert.match(verifyWorkflow, /workflow_dispatch:/);
  assert.match(verifyWorkflow, /permissions:\n\s+contents: read\n/, "re-verification must hold read-only permission");
  assert.doesNotMatch(verifyWorkflow, /secrets\.|vars\./, "re-verification must stay credential-free");
  assert.doesNotMatch(verifyWorkflow, /id-token/, "re-verification must not request a publishing identity");
  assert.doesNotMatch(verifyWorkflow, /environment:/, "re-verification must not enter the protected publishing environment");
  assert.doesNotMatch(verifyWorkflow, /gh-action-pypi-publish/, "re-verification must not publish");
  assert.doesNotMatch(verifyWorkflow, /(?:python\s+-m\s+build|pip\s+wheel|\bbuild\s+--)/i, "re-verification must not rebuild");
  assert.equal((verifyWorkflow.match(/uses: actions\/setup-python@/g) ?? []).length, 4, "re-verification must cover exactly four CPython runtimes");
  assert.equal(
    (verifyWorkflow.match(/if: \$\{\{ !cancelled\(\) \}\}/g) ?? []).length,
    9,
    "every re-verification runtime and the evidence upload must survive an earlier runtime failure",
  );
  assert.equal((verifyWorkflow.match(/ \|\| status=\$\?$/gm) ?? []).length, 8, "both artifact proofs must run in every re-verification runtime");
  assert.equal((verifyWorkflow.match(/^\s+exit "\$status"$/gm) ?? []).length, 4, "every re-verification runtime must still propagate its failure");
  for (const version of ["3.11", "3.12", "3.13", "3.14"]) {
    assert.equal((verifyWorkflow.match(new RegExp(`python-version: "${version.replace(".", "\\.")}"`, "g")) ?? []).length, 1, `re-verification CPython ${version} drifted`);
    for (const kind of ["wheel", "sdist"]) {
      assert.match(
        verifyWorkflow,
        new RegExp(`--artifact-kind ${kind} --expected-python ${version.replace(".", "\\.")} --provenance reverification[^\\n]+-${version.replace(".", "\\.")}-${kind}`),
        `re-verification ${version}/${kind} drifted`,
      );
    }
  }
  return { manifest, files: actualPaths.length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { manifest, files } = validateExport();
  console.log(`public export ok (${files} files, ${manifest.identity.distribution}@${manifest.identity.version})`);
}
