#!/usr/bin/env node

// A failing live Echo must not cost a runtime its second credential-free
// record. These tests execute the real workflow shell blocks with a stand-in
// verifier that fails the way a configured live Echo failure fails, then
// assert every artifact record still landed and the block still failed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "export-manifest.json"), "utf8"));
const runtimes = manifest.verification.clean_install_cpython;
const kinds = manifest.verification.clean_install_artifact_kinds;
const registryArtifacts = Object.fromEntries(
  manifest.artifacts.map((artifact) => [artifact.filename, { sha256: artifact.sha256, url: "https://files.pythonhosted.org/recorded" }]),
);

// Reads the `run: |` blocks straight out of the workflow, so the tests exercise
// the shell the runner actually executes rather than a copy of it.
function runtimeBlocks(workflowPath) {
  const lines = readFileSync(resolve(repositoryRoot, workflowPath), "utf8").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = lines[index].match(/^(\s+)run: \|$/);
    if (!opener) continue;
    const indent = opener[1].length + 2;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === "") {
        body.push("");
        continue;
      }
      if (lines[cursor].search(/\S/) < indent) break;
      body.push(lines[cursor].slice(indent));
    }
    const script = body.join("\n");
    if (script.includes("verify-published-release.py")) blocks.push(script);
  }
  return blocks;
}

function standInVerifier() {
  return [
    `#!${process.execPath}`,
    "// Writes the evidence record the real verifier writes on the far side of",
    "// its credential-free proofs, then exits nonzero the way a configured but",
    "// failing live Echo exits.",
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    "const { dirname } = require('node:path');",
    "const argv = process.argv.slice(2);",
    "const flag = (name) => argv[argv.indexOf(name) + 1];",
    "const out = flag('--out');",
    "mkdirSync(dirname(out), { recursive: true });",
    "writeFileSync(out, JSON.stringify({",
    `  schema_version: 2,`,
    `  distribution: ${JSON.stringify(manifest.identity.distribution)},`,
    `  version: ${JSON.stringify(manifest.identity.version)},`,
    "  python: flag('--expected-python'),",
    "  installed_artifact_kind: flag('--artifact-kind'),",
    "  provenance: flag('--provenance'),",
    "  evidence_id: flag('--evidence-id'),",
    "  credential_free_proof: {",
    "    registry_inventory_matches_candidate: true,",
    "    registry_metadata_hashes_match: true,",
    "    downloaded_artifact_hashes_match: true,",
    "    clean_install_completed: true,",
    "    installed_surface_smoke_completed: true,",
    "  },",
    `  registry_artifacts: ${JSON.stringify(registryArtifacts)},`,
    "  live_echo: { status: 'failed', reason: 'live_echo_call_failed', exit_code: 1 },",
    "  result_content_expected: false,",
    "}, null, 2) + '\\n');",
    "process.exit(1);",
  ].join("\n");
}

function runBlocksWithFailingLiveEcho(workflowPath) {
  const workdir = mkdtempSync(resolve(tmpdir(), "solver-python-failure-path-"));
  const binary = resolve(workdir, "stand-in");
  mkdirSync(binary);
  const shim = resolve(binary, "python");
  writeFileSync(shim, standInVerifier());
  chmodSync(shim, 0o755);

  const blocks = runtimeBlocks(workflowPath);
  const statuses = [];
  for (const [index, block] of blocks.entries()) {
    const script = resolve(workdir, `block-${index}.sh`);
    writeFileSync(script, block);
    // `bash -e` is how the runner invokes a `run:` block, and errexit is
    // precisely what used to abandon the second artifact call.
    const result = spawnSync("bash", ["-e", script], {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binary}:${process.env.PATH}`,
        GITHUB_RUN_ID: "run",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    statuses.push(result.status);
  }
  return { workdir, blocks, statuses, evidenceDir: resolve(workdir, "evidence") };
}

function gate(evidenceDir, provenance) {
  return spawnSync(
    "python3",
    [resolve(repositoryRoot, "scripts/check-retained-evidence.py"), "--provenance", provenance, "--evidence-dir", evidenceDir],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

for (const [workflowPath, provenance] of [
  [".github/workflows/publish.yml", "publish"],
  [".github/workflows/verify-release.yml", "reverification"],
]) {
  test(`${provenance}: a failing live Echo still leaves every artifact record, and still fails`, () => {
    const { workdir, blocks, statuses, evidenceDir } = runBlocksWithFailingLiveEcho(workflowPath);
    try {
      assert.equal(blocks.length, runtimes.length, "every supported runtime must have a verification block");
      for (const [index, status] of statuses.entries()) {
        assert.notEqual(status, 0, `runtime block ${index} swallowed a verification failure`);
      }

      const retained = readdirSync(evidenceDir).toSorted();
      const expected = runtimes.flatMap((python) => kinds.map((kind) => `python-${python}-${kind}.json`)).toSorted();
      assert.deepEqual(retained, expected, "a failing live Echo cost the run some of its credential-free records");

      for (const python of runtimes) {
        for (const kind of kinds) {
          const record = JSON.parse(readFileSync(resolve(evidenceDir, `python-${python}-${kind}.json`), "utf8"));
          assert.equal(record.python, python, `python-${python}-${kind} evidence is bound to the wrong interpreter`);
          assert.equal(record.installed_artifact_kind, kind, `python-${python}-${kind} evidence is bound to the wrong artifact`);
          assert.equal(record.provenance, provenance, `python-${python}-${kind} evidence is bound to the wrong provenance`);
          assert.equal(Object.values(record.credential_free_proof).every((value) => value === true), true);
        }
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test(`${provenance}: the completeness gate reports a failed live Echo and an absent record`, () => {
    const { workdir, evidenceDir } = runBlocksWithFailingLiveEcho(workflowPath);
    try {
      const failed = gate(evidenceDir, provenance);
      assert.notEqual(failed.status, 0, "the gate accepted a failed live Echo");
      assert.match(`${failed.stdout}${failed.stderr}`, /live Echo failed with exit code 1/);

      // The same records with the live Echo recorded as not run are exactly the
      // credential-absent case, which is complete evidence and must pass.
      for (const name of readdirSync(evidenceDir)) {
        const path = resolve(evidenceDir, name);
        const record = JSON.parse(readFileSync(path, "utf8"));
        record.live_echo = { status: "not_run", reason: "credentials_absent", absent_configuration: ["SOLVERAPI_API_KEY"] };
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      }
      const accepted = gate(evidenceDir, provenance);
      assert.equal(accepted.status, 0, `the gate rejected complete credential-absent evidence: ${accepted.stdout}${accepted.stderr}`);
      assert.match(accepted.stdout, /live Echo 8 not_run/);

      rmSync(resolve(evidenceDir, `python-${runtimes[0]}-${kinds[1]}.json`));
      const incomplete = gate(evidenceDir, provenance);
      assert.notEqual(incomplete.status, 0, "the gate accepted an incomplete evidence set");
      assert.match(`${incomplete.stdout}${incomplete.stderr}`, /missing, so this runtime and artifact have no retained proof/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}
