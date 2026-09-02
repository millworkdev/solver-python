#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateExport } from "./check-export.mjs";
import {
  authorizationDigest,
  buildAuthorizationPayload,
  canonicalAuthorizationJson,
  parseAuthorizationTimestamp,
} from "./authorization-payload.mjs";

const exactRepository = "millworkdev/solver-python";
const exactWorkflowRef = `${exactRepository}/.github/workflows/publish.yml@refs/heads/main`;
const exactProject = "millwork-solver";
const exactVersion = "0.1.0";
const fullSha = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const authorizationRef = /^https:\/\/github\.com\/millworkdev\/solver-python\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/;
const tokenEnvironmentNames = ["PYPI_API_TOKEN", "TWINE_PASSWORD", "TWINE_USERNAME"];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function validateExecutionEnvironment(environment) {
  assert.equal(environment.EXPECTED_VERSION, exactVersion, "dispatch version does not match the retained candidate");
  assert.match(environment.EXPECTED_EXPORT_SHA ?? "", fullSha, "reviewed export SHA must be full");
  assert.equal(environment.EXPECTED_EXPORT_SHA, environment.GITHUB_SHA, "dispatch SHA does not match reviewed export SHA");
  assert.equal(environment.GITHUB_ACTOR, "matt783", "dispatch actor must be the operator matt783");
  assert.equal(environment.GITHUB_TRIGGERING_ACTOR, "matt783", "triggering actor must be the operator matt783");
  assert.equal(environment.GITHUB_RUN_ATTEMPT, "1", "publish authorization permits only the first workflow attempt");
  assert.equal(environment.GITHUB_REPOSITORY, exactRepository, "repository binding drifted");
  assert.equal(environment.GITHUB_REF, "refs/heads/main", "publishing is main-only");
  assert.equal(environment.GITHUB_REF_TYPE, "branch", "publishing requires a branch ref");
  assert.equal(environment.GITHUB_WORKFLOW_REF, exactWorkflowRef, "workflow/ref binding drifted");
  assert.equal(environment.EXPECTED_ENVIRONMENT, "pypi-publish", "protected environment binding drifted");
  for (const name of tokenEnvironmentNames) {
    assert.equal(environment[name], undefined, `${name} must be absent for OIDC publishing`);
  }
}

function validateRegistryResponse(response) {
  assert.equal(response.url, `https://pypi.org/pypi/${exactProject}/${exactVersion}/json`, "registry lookup URL drifted");
  assert.equal(response.status, 404, "refusing because the exact PyPI version is not definitively absent");
  assert.match(response.content_type.toLowerCase(), /^application\/json(?:;|$)/, "registry absence response must be JSON");
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    assert.fail("registry absence response body must parse as JSON");
  }
  assert.deepEqual(body, { message: "Not Found" }, "registry absence response is ambiguous");
}

function validateAuthorizationResponse(response, environment, expectedDigest) {
  const match = (environment.AUTHORIZATION_REF ?? "").match(authorizationRef);
  assert.ok(match, "authorization ref must name a public solver-python comment");
  const expectedApiUrl = `https://api.github.com/repos/millworkdev/solver-python/issues/comments/${match[1]}`;
  assert.equal(response.url, expectedApiUrl, "authorization API URL drifted");
  assert.equal(response.status, 200, "operator authorization comment does not exist");
  assert.match(response.content_type.toLowerCase(), /^application\/json(?:;|$)/, "authorization response must be JSON");
  const comment = JSON.parse(response.body);
  assert.equal(comment.html_url, environment.AUTHORIZATION_REF, "authorization comment URL drifted");
  assert.equal(environment.AUTHORIZATION_ACTOR, "matt783", "authorization actor must be the operator matt783");
  assert.equal(comment.user?.login, environment.AUTHORIZATION_ACTOR, "authorization comment author drifted");
  assert.equal(comment.created_at, environment.AUTHORIZATION_ISSUED_AT, "authorization comment creation time drifted");
  assert.equal(comment.updated_at, comment.created_at, "edited authorization comments are forbidden");
  const issuedAt = parseAuthorizationTimestamp(comment.created_at, "authorization comment created_at");
  const expiresAt = parseAuthorizationTimestamp(environment.AUTHORIZATION_EXPIRES_AT, "authorization expires_at");
  assert.ok(issuedAt < expiresAt, "authorization comment must precede expiry");
  assert.ok(expiresAt - issuedAt <= 86_400_000, "authorization lifetime exceeds 24 hours");
  const current = Date.now();
  assert.ok(issuedAt <= current && current <= expiresAt, "authorization is not currently valid");
  const authorization = JSON.parse(comment.body);
  assert.deepEqual(Object.keys(authorization).toSorted(), ["authorization_sha256", "schema_id"], "authorization comment fields drifted");
  assert.equal(authorization.schema_id, "millworkdev.solver-python.bounded-publish-authorization.v1", "authorization comment schema drifted");
  assert.equal(authorization.authorization_sha256, expectedDigest, "authorization comment does not approve the exact payload");
}

async function loadAuthorizationResponse(reference) {
  const fixture = argument("--authorization-response-file");
  if (fixture) return JSON.parse(readFileSync(resolve(fixture), "utf8"));
  const match = (reference ?? "").match(authorizationRef);
  assert.ok(match, "authorization ref must name a public solver-python comment");
  const url = `https://api.github.com/repos/millworkdev/solver-python/issues/comments/${match[1]}`;
  const response = await fetch(url, {
    redirect: "error",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "solver-python-publish-guard" },
  });
  return {
    url: response.url,
    status: response.status,
    content_type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

async function loadRegistryResponse() {
  const fixture = argument("--registry-response-file");
  if (fixture) return JSON.parse(readFileSync(resolve(fixture), "utf8"));
  const url = `https://pypi.org/pypi/${exactProject}/${exactVersion}/json`;
  const response = await fetch(url, { redirect: "error", headers: { Accept: "application/json" } });
  return {
    url: response.url,
    status: response.status,
    content_type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

const { manifest } = validateExport();
validateExecutionEnvironment(process.env);
const manifestBytes = readFileSync(resolve("export-manifest.json"));
const bindingPath = argument("--release-binding-file") ?? "publish-binding.json";
const bindingBytes = readFileSync(resolve(bindingPath));
const binding = JSON.parse(bindingBytes);
const authorizationPayload = buildAuthorizationPayload({
  environment: process.env,
  manifest,
  manifestBytes,
  binding,
  bindingBytes,
});
const expectedAuthorizationDigest = authorizationDigest(authorizationPayload);
if (process.argv.includes("--print-authorization-payload")) {
  console.log(JSON.stringify({
    payload: authorizationPayload,
    canonical_json: canonicalAuthorizationJson(authorizationPayload),
    sha256: expectedAuthorizationDigest,
  }, null, 2));
  process.exit(0);
}
assert.match(process.env.AUTHORIZATION_SHA256 ?? "", sha256, "bounded authorization digest must be SHA-256");
assert.equal(process.env.AUTHORIZATION_SHA256, expectedAuthorizationDigest, "bounded authorization digest does not bind the exact payload");
validateAuthorizationResponse(
  await loadAuthorizationResponse(process.env.AUTHORIZATION_REF),
  process.env,
  expectedAuthorizationDigest,
);
validateRegistryResponse(await loadRegistryResponse());
console.log(`${exactProject}@${exactVersion} publish preconditions ok; no publication performed`);
