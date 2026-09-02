import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const exactRepository = "millworkdev/solver-python";
const exactWorkflowRef = `${exactRepository}/.github/workflows/publish.yml@refs/heads/main`;
const exactProject = "millwork-solver";
const exactVersion = "0.1.0";
const exactSchema = "millworkdev.solver-python.bounded-publish-authorization.v1";
const exactActions = ["publish_retained_artifacts", "verify_published_artifacts"];
const exactOperator = "matt783";
const fullSha = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const utcSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).toSorted(), [...expected].toSorted(), `${label} keys drifted`);
}

export function parseAuthorizationTimestamp(value, label) {
  assert.match(value ?? "", utcSeconds, `${label} must use UTC RFC 3339 seconds`);
  const milliseconds = Date.parse(value);
  assert.equal(new Date(milliseconds).toISOString().replace(".000Z", "Z"), value, `${label} is not canonical`);
  return milliseconds;
}

export function canonicalAuthorizationJson(payload) {
  return JSON.stringify(canonical(payload));
}

export function authorizationDigest(payload) {
  return digest(canonicalAuthorizationJson(payload));
}

export function validateReleaseBinding(binding, exactArtifacts, { requireReady = true } = {}) {
  exactKeys(binding, ["artifacts", "binding_id", "private_source_assurance", "publication", "reviewed_public_export_sha", "schema_version", "status"], "private-source bridge");
  assert.equal(binding.schema_version, 1);
  assert.equal(binding.binding_id, "millworkdev.solver-python.private-source-bridge.v1");
  assert.deepEqual(binding.artifacts, exactArtifacts, "private-source bridge artifact binding drifted");
  assert.deepEqual(binding.publication, { published: false, external_mutation_performed: false }, "private-source bridge must precede publication");
  exactKeys(binding.private_source_assurance, ["assurance_id", "assurance_sha256"], "private source assurance");
  if (binding.status === "operator_evidence_required" && !requireReady) {
    assert.equal(binding.reviewed_public_export_sha, null, "pending bridge cannot invent a reviewed export SHA");
    assert.deepEqual(binding.private_source_assurance, { assurance_id: null, assurance_sha256: null }, "pending bridge cannot invent private source assurance");
    return;
  }
  assert.equal(binding.status, "ready_for_operator_dispatch", "signed private source and reviewed export evidence are required");
  assert.match(binding.reviewed_public_export_sha ?? "", fullSha, "reviewed public export SHA must be full");
  assert.match(binding.private_source_assurance.assurance_id ?? "", /^millwork-solver-0\.1\.0-source-assurance-[0-9a-f]{16}$/, "private source assurance ID drifted");
  assert.match(binding.private_source_assurance.assurance_sha256 ?? "", sha256, "private source assurance digest must be SHA-256");
  assert.equal(
    binding.private_source_assurance.assurance_id,
    `millwork-solver-0.1.0-source-assurance-${binding.private_source_assurance.assurance_sha256.slice(0, 16)}`,
    "private source assurance ID/digest relation drifted",
  );
}

export function buildAuthorizationPayload({ environment, manifest, manifestBytes, binding, bindingBytes, now = new Date() }) {
  assert.equal(environment.AUTHORIZATION_ACTOR, exactOperator, "authorization actor must be the operator matt783");
  assert.equal(environment.GITHUB_ACTOR, exactOperator, "dispatch actor must be the operator matt783");
  const expiresAt = parseAuthorizationTimestamp(environment.AUTHORIZATION_EXPIRES_AT, "authorization expires_at");
  assert.ok(now.getTime() <= expiresAt, "authorization expiry is not in the future");
  assert.equal(manifest.workflow_binding.authorization_payload_schema, exactSchema, "authorization schema drifted");
  assert.equal(manifest.workflow_binding.authorization_max_lifetime_seconds, 86400, "authorization lifetime policy drifted");
  assert.deepEqual(manifest.workflow_binding.authorization_actions, exactActions, "authorization actions drifted");
  validateReleaseBinding(binding, manifest.artifacts);
  return {
    schema_id: exactSchema,
    authorized_by: environment.AUTHORIZATION_ACTOR,
    dispatched_by: environment.GITHUB_ACTOR,
    expires_at: environment.AUTHORIZATION_EXPIRES_AT,
    execution_bounds: { maximum_attempts: 1 },
    actions: exactActions,
    targets: {
      repository: exactRepository,
      workflow_ref: exactWorkflowRef,
      environment: "pypi-publish",
      project: exactProject,
      version: exactVersion,
      execution_sha: environment.EXPECTED_EXPORT_SHA,
      reviewed_public_export_sha: binding.reviewed_public_export_sha,
      export_manifest_sha256: digest(manifestBytes),
      private_source_bridge_sha256: digest(bindingBytes),
      private_source_assurance: binding.private_source_assurance,
      candidate_packet_sha256: manifest.candidate_evidence.packet_sha256,
      artifacts: manifest.artifacts,
    },
  };
}
