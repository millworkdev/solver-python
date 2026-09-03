#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authorizationDigest, buildAuthorizationPayload } from "./authorization-payload.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = resolve(repositoryRoot, "scripts/check-publish-preconditions.mjs");
const manifestBytes = readFileSync(resolve(repositoryRoot, "export-manifest.json"));
const manifest = JSON.parse(manifestBytes);
const now = new Date();
const issuedAt = new Date(Math.floor((now.getTime() - 60_000) / 1000) * 1000).toISOString().replace(".000Z", "Z");
const expiresAt = new Date(Math.floor((now.getTime() + 3_600_000) / 1000) * 1000).toISOString().replace(".000Z", "Z");
const baseEnvironment = {
  EXPECTED_VERSION: "0.1.0",
  EXPECTED_EXPORT_SHA: "a".repeat(40),
  GITHUB_SHA: "a".repeat(40),
  GITHUB_ACTOR: "matt783",
  GITHUB_TRIGGERING_ACTOR: "matt783",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "millworkdev/solver-python",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_TYPE: "branch",
  GITHUB_WORKFLOW_REF: "millworkdev/solver-python/.github/workflows/publish.yml@refs/heads/main",
  EXPECTED_ENVIRONMENT: "pypi-publish",
  AUTHORIZATION_ACTOR: "matt783",
  AUTHORIZATION_REF: "https://github.com/millworkdev/solver-python/issues/1#issuecomment-123456",
  AUTHORIZATION_ISSUED_AT: issuedAt,
  AUTHORIZATION_EXPIRES_AT: expiresAt,
};
const readyBinding = {
  schema_version: 1,
  binding_id: "millworkdev.solver-python.private-source-bridge.v1",
  status: "ready_for_operator_dispatch",
  reviewed_public_export_sha: "d".repeat(40),
  private_source_assurance: {
    assurance_id: "millwork-solver-0.1.0-source-assurance-eeeeeeeeeeeeeeee",
    assurance_sha256: "e".repeat(64),
  },
  artifacts: manifest.artifacts,
  publication: { published: false, external_mutation_performed: false },
};
const readyBindingBytes = Buffer.from(`${JSON.stringify(readyBinding, null, 2)}\n`);
const absent = {
  url: "https://pypi.org/pypi/millwork-solver/0.1.0/json",
  status: 404,
  content_type: "application/json",
  body: JSON.stringify({ message: "Not Found" }),
};

function boundEnvironment() {
  const environment = { ...baseEnvironment };
  environment.AUTHORIZATION_SHA256 = authorizationDigest(buildAuthorizationPayload({
    environment,
    manifest,
    manifestBytes,
    binding: readyBinding,
    bindingBytes: readyBindingBytes,
    now,
  }));
  return environment;
}

function authorizationResponse(environment) {
  return {
    url: "https://api.github.com/repos/millworkdev/solver-python/issues/comments/123456",
    status: 200,
    content_type: "application/json",
    body: JSON.stringify({
      html_url: environment.AUTHORIZATION_REF,
      user: { login: environment.AUTHORIZATION_ACTOR },
      created_at: environment.AUTHORIZATION_ISSUED_AT,
      updated_at: environment.AUTHORIZATION_ISSUED_AT,
      body: JSON.stringify({
        schema_id: "millworkdev.solver-python.bounded-publish-authorization.v1",
        authorization_sha256: environment.AUTHORIZATION_SHA256,
      }),
    }),
  };
}

function run({ environment = boundEnvironment(), response = absent, binding = readyBindingBytes, authorization = authorizationResponse(environment) } = {}) {
  const temporary = mkdtempSync(resolve(tmpdir(), "solver-python-publish-guard-"));
  const fixture = resolve(temporary, "response.json");
  const bindingFixture = resolve(temporary, "binding.json");
  const authorizationFixture = resolve(temporary, "authorization-response.json");
  writeFileSync(fixture, `${JSON.stringify(response)}\n`);
  writeFileSync(bindingFixture, binding);
  writeFileSync(authorizationFixture, `${JSON.stringify(authorization)}\n`);
  const env = { PATH: process.env.PATH, ...environment };
  const result = spawnSync(process.execPath, [guard, "--registry-response-file", fixture, "--release-binding-file", bindingFixture, "--authorization-response-file", authorizationFixture], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
  rmSync(temporary, { recursive: true, force: true });
  return result;
}

function negative(name, expected, mutateEnvironment, mutateResponse, mutateAuthorization) {
  test(name, () => {
    const environment = boundEnvironment();
    const response = structuredClone(absent);
    mutateEnvironment?.(environment);
    mutateResponse?.(response);
    const authorization = authorizationResponse(environment);
    mutateAuthorization?.(authorization);
    const result = run({ environment, response, authorization });
    assert.notEqual(result.status, 0, "DRIFT_NOT_DETECTED: guard unexpectedly passed");
    assert.match(`${result.stdout}${result.stderr}`, expected);
  });
}

test("a definitive exact-version 404 and exact semantic authorization pass without publishing", () => {
  const result = run();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /publish preconditions ok; no publication performed/);
});

test("GitHub-assigned comment identity and creation time do not make the payload self-referential", () => {
  const first = boundEnvironment();
  const second = {
    ...first,
    AUTHORIZATION_REF: "https://github.com/millworkdev/solver-python/issues/2#issuecomment-654321",
    AUTHORIZATION_ISSUED_AT: new Date(Math.floor((now.getTime() - 30_000) / 1000) * 1000).toISOString().replace(".000Z", "Z"),
  };
  const firstPayload = buildAuthorizationPayload({ environment: first, manifest, manifestBytes, binding: readyBinding, bindingBytes: readyBindingBytes, now });
  const secondPayload = buildAuthorizationPayload({ environment: second, manifest, manifestBytes, binding: readyBinding, bindingBytes: readyBindingBytes, now });
  assert.equal(authorizationDigest(firstPayload), authorizationDigest(secondPayload));
});

test("the canonical payload can be printed before GitHub assigns a comment ref and creation time", () => {
  const environment = boundEnvironment();
  delete environment.AUTHORIZATION_REF;
  delete environment.AUTHORIZATION_ISSUED_AT;
  delete environment.AUTHORIZATION_SHA256;
  const temporary = mkdtempSync(resolve(tmpdir(), "solver-python-authorization-print-"));
  try {
    const bindingFixture = resolve(temporary, "binding.json");
    writeFileSync(bindingFixture, readyBindingBytes);
    const result = spawnSync(process.execPath, [guard, "--print-authorization-payload", "--release-binding-file", bindingFixture], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, ...environment },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const printed = JSON.parse(result.stdout);
    assert.match(printed.sha256, /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(printed.payload, "authorization_ref"), false);
    assert.equal(Object.hasOwn(printed.payload, "issued_at"), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

negative("an existing immutable version is refused", /not definitively absent/, undefined, (response) => {
  response.status = 200;
  response.body = JSON.stringify({ info: { version: "0.1.0" } });
});
negative("an ambiguous 404 body is refused", /absence response is ambiguous/, undefined, (response) => {
  response.body = JSON.stringify({ message: "cache miss" });
});
negative("a registry redirect or lookalike URL is refused", /registry lookup URL drifted/, undefined, (response) => {
  response.url = "https://pypi.example.invalid/pypi/millwork-solver/0.1.0/json";
});
negative("a wrong version input is refused", /dispatch version does not match/, (environment) => {
  environment.EXPECTED_VERSION = "0.1.1";
});
negative("a wrong repository is refused", /repository binding drifted/, (environment) => {
  environment.GITHUB_REPOSITORY = "millworkdev/lookalike";
});
negative("a wrong workflow ref is refused", /workflow\/ref binding drifted/, (environment) => {
  environment.GITHUB_WORKFLOW_REF = "millworkdev/solver-python/.github/workflows/release.yml@refs/heads/main";
});
negative("a different dispatch SHA is refused", /dispatch SHA does not match reviewed export SHA/, (environment) => {
  environment.GITHUB_SHA = "c".repeat(40);
});
negative("a collaborator rerun is refused", /triggering actor must be the operator matt783/, (environment) => {
  environment.GITHUB_TRIGGERING_ACTOR = "repository-collaborator";
});
negative("a second workflow attempt is refused", /permits only the first workflow attempt/, (environment) => {
  environment.GITHUB_RUN_ATTEMPT = "2";
});
negative("a malformed authorization digest is refused", /bounded authorization digest/, (environment) => {
  environment.AUTHORIZATION_SHA256 = "todo";
});
negative("a well-formed but unrelated digest is refused", /does not bind the exact payload/, (environment) => {
  environment.AUTHORIZATION_SHA256 = "b".repeat(64);
});
negative("a non-operator authorization actor is refused", /authorization actor must be the operator matt783/, (environment) => {
  environment.AUTHORIZATION_ACTOR = "different-operator";
});
negative("a mutable authorization reference is refused", /authorization ref must name a public solver-python comment/, (environment) => {
  environment.AUTHORIZATION_REF = "https://github.com/millworkdev/solver-python/issues/1";
});
negative("a nonexistent authorization comment is refused", /operator authorization comment does not exist/, undefined, undefined, (authorization) => {
  authorization.status = 404;
  authorization.body = JSON.stringify({ message: "Not Found" });
});
negative("a comment by a different actor is refused", /authorization comment author drifted/, undefined, undefined, (authorization) => {
  const body = JSON.parse(authorization.body);
  body.user.login = "unrelated-user";
  authorization.body = JSON.stringify(body);
});
negative("a comment created outside the bound window is refused", /authorization comment creation time drifted/, undefined, undefined, (authorization) => {
  const body = JSON.parse(authorization.body);
  body.created_at = "2026-01-01T00:00:00Z";
  body.updated_at = body.created_at;
  authorization.body = JSON.stringify(body);
});
negative("an edited authorization comment is refused", /edited authorization comments are forbidden/, undefined, undefined, (authorization) => {
  const body = JSON.parse(authorization.body);
  body.updated_at = expiresAt;
  authorization.body = JSON.stringify(body);
});
negative("a comment approving a different payload is refused", /does not approve the exact payload/, undefined, undefined, (authorization) => {
  const body = JSON.parse(authorization.body);
  const approval = JSON.parse(body.body);
  approval.authorization_sha256 = "f".repeat(64);
  body.body = JSON.stringify(approval);
  authorization.body = JSON.stringify(body);
});
negative("an authorization window longer than 24 hours is refused", /lifetime exceeds 24 hours/, (environment) => {
  environment.AUTHORIZATION_EXPIRES_AT = new Date(Date.parse(issuedAt) + 86_401_000).toISOString().replace(".000Z", "Z");
  environment.AUTHORIZATION_SHA256 = authorizationDigest(buildAuthorizationPayload({
    environment,
    manifest,
    manifestBytes,
    binding: readyBinding,
    bindingBytes: readyBindingBytes,
    now,
  }));
});
negative("an expired authorization is refused", /authorization expiry is not in the future/, (environment) => {
  environment.AUTHORIZATION_ISSUED_AT = "2026-01-01T00:00:00Z";
  environment.AUTHORIZATION_EXPIRES_AT = "2026-01-01T01:00:00Z";
});
test("pending signed-private-source evidence keeps the publish guard closed", () => {
  // Built inline rather than read from the committed publish-binding.json: once the
  // operator's signed private-source evidence lands, that file is legitimately
  // ready_for_operator_dispatch, and reading it here would assert the opposite of
  // the state the repository is supposed to reach before a dispatch.
  const pendingBinding = structuredClone(readyBinding);
  pendingBinding.status = "operator_evidence_required";
  pendingBinding.reviewed_public_export_sha = null;
  pendingBinding.private_source_assurance = { assurance_id: null, assurance_sha256: null };
  const pending = Buffer.from(`${JSON.stringify(pendingBinding, null, 2)}\n`);
  const result = run({ binding: pending });
  assert.notEqual(result.status, 0, "DRIFT_NOT_DETECTED: pending private-source bridge authorized publication");
  assert.match(`${result.stdout}${result.stderr}`, /signed private source and reviewed export evidence are required/);
});
test("a public assurance ID not derived from its digest is refused", () => {
  const binding = structuredClone(readyBinding);
  binding.private_source_assurance.assurance_id = "millwork-solver-0.1.0-source-assurance-ffffffffffffffff";
  const result = run({ binding: Buffer.from(`${JSON.stringify(binding, null, 2)}\n`) });
  assert.notEqual(result.status, 0, "DRIFT_NOT_DETECTED: unrelated assurance ID was accepted");
  assert.match(`${result.stdout}${result.stderr}`, /private source assurance ID\/digest relation drifted/);
});
negative("a PyPI token is refused", /PYPI_API_TOKEN must be absent/, (environment) => {
  environment.PYPI_API_TOKEN = "fixture-token";
});
