#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "solver-python-export-"));
  cpSync(repositoryRoot, root, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes(".git"),
  });
  return root;
}

function repin(root, path) {
  const manifestPath = resolve(root, "export-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bytes = readFileSync(resolve(root, path));
  const entry = manifest.files.find((item) => item.path === path);
  assert.ok(entry, `fixture path not in manifest: ${path}`);
  entry.sha256 = digest(bytes);
  entry.size_bytes = bytes.length;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function failure(root) {
  try {
    execFileSync(process.execPath, [resolve(root, "scripts/check-export.mjs")], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail("DRIFT_NOT_DETECTED: export unexpectedly passed");
}

function negative(name, expected, mutate) {
  test(name, () => {
    const root = fixture();
    try {
      mutate(root);
      assert.match(failure(root), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the staged public export passes its own closed-world check", () => {
  execFileSync(process.execPath, [resolve(repositoryRoot, "scripts/check-export.mjs")], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
});

negative("wrong wheel bytes fail at the artifact hash boundary", /millwork_solver-0\.1\.0-py3-none-any\.whl hash drifted/, (root) => {
  const path = resolve(root, "dist/millwork_solver-0.1.0-py3-none-any.whl");
  const bytes = readFileSync(path);
  bytes[0] ^= 1;
  writeFileSync(path, bytes);
});

negative("repinning altered wheel bytes in the manifest cannot replace the retained candidate", /exact retained binding drifted/, (root) => {
  const artifactPath = "dist/millwork_solver-0.1.0-py3-none-any.whl";
  const absolute = resolve(root, artifactPath);
  const bytes = readFileSync(absolute);
  bytes[0] ^= 1;
  writeFileSync(absolute, bytes);
  const manifestPath = resolve(root, "export-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const replacement = manifest.artifacts.find((artifact) => artifact.kind === "wheel");
  replacement.sha256 = digest(bytes);
  replacement.size_bytes = bytes.length;
  const file = manifest.files.find((entry) => entry.path === artifactPath);
  file.sha256 = digest(bytes);
  file.size_bytes = bytes.length;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
});

negative("an extra public file fails the closed inventory", /public export inventory drifted/, (root) => {
  writeFileSync(resolve(root, "unreviewed.txt"), "not reviewed\n");
});

negative("a secret-shaped value fails even when its file hash is repinned", /GitHub token forbidden/, (root) => {
  const path = "README.md";
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n${"ghp_" + "A".repeat(36)}\n`);
  repin(root, path);
});

negative("time-sensitive registry prose fails even when repinned", /time-sensitive registry prose forbidden/, (root) => {
  const path = "README.md";
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\nThis is ${["not on", "PyPI"].join(" ")}.\n`);
  repin(root, path);
});

negative("an internal work-row label fails even when repinned", /internal work-row identifier forbidden/, (root) => {
  const path = "README.md";
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n${"P" + "Y3"} evidence.\n`);
  repin(root, path);
});

for (const [prefix, number] of [["G", "1"], ["PUB", "1"], ["SH", "1"]]) {
  const marker = `${prefix}-${number}`;
  negative(`${marker} internal work-row syntax fails even when repinned`, /internal work-row identifier forbidden/, (root) => {
    const path = "README.md";
    writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n${marker} evidence.\n`);
    repin(root, path);
  });
}

negative("internal issue shorthand fails even when repinned", /internal issue shorthand forbidden/, (root) => {
  const path = "README.md";
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\nSee ${"#" + "418"}.\n`);
  repin(root, path);
});

negative("a private source coordinate fails even when repinned", /private coordinate forbidden/, (root) => {
  const path = "README.md";
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n${"matt783" + "/solverAPI"}.\n`);
  repin(root, path);
});

negative("a customer account identifier fails even when repinned", /provider\/customer identifier forbidden/, (root) => {
  const path = "README.md";
  const marker = ["customer", "account", "id"].join("_");
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n${marker} = "acct_123456"\n`);
  repin(root, path);
});

negative("a provider tenant identity fails even when repinned", /provider\/customer identity forbidden/, (root) => {
  const path = "README.md";
  const marker = ["provider", "name"].join("_");
  writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n${marker} = "customer production tenant"\n`);
  repin(root, path);
});

negative("a mutable action reference fails even when repinned", /action must be pinned to a full SHA/, (root) => {
  const path = ".github/workflows/publish.yml";
  const absolute = resolve(root, path);
  writeFileSync(absolute, readFileSync(absolute, "utf8").replace(
    "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
    "pypa/gh-action-pypi-publish@release/v1",
  ));
  repin(root, path);
});

negative("a rebuild command fails even when repinned", /publish workflow must not rebuild/, (root) => {
  const path = ".github/workflows/publish.yml";
  const absolute = resolve(root, path);
  writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n# python -m build\n`);
  repin(root, path);
});

negative("publication authority cannot be smuggled into the manifest", /publication facts must remain false/, (root) => {
  const path = resolve(root, "export-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.publication.published = true;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
});

negative("a different protected environment fails closed", /workflow binding drifted/, (root) => {
  const path = resolve(root, "export-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.workflow_binding.environment = "production";
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
});

negative("a different version fails closed", /identity drifted/, (root) => {
  const path = resolve(root, "export-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.identity.version = "0.1.1";
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
});

negative("dropping the evidence-retention guard fails even when repinned", /must survive an earlier verification failure/, (root) => {
  const path = ".github/workflows/publish.yml";
  const absolute = resolve(root, path);
  const text = readFileSync(absolute, "utf8");
  const guard = "      - name: Retain exact post-publish verification evidence\n        if: ${{ !cancelled() && steps.upload.outcome == 'success' }}\n";
  assert.ok(text.includes(guard), "fixture no longer contains the evidence-retention guard");
  writeFileSync(absolute, text.replace(guard, "      - name: Retain exact post-publish verification evidence\n"));
  repin(root, path);
});

negative("unbinding post-publish evidence from its interpreter fails even when repinned", /evidence must be bound to the interpreter/, (root) => {
  const path = ".github/workflows/publish.yml";
  const absolute = resolve(root, path);
  const text = readFileSync(absolute, "utf8");
  assert.ok(text.includes("--expected-python 3.11 --provenance publish"), "fixture no longer binds evidence to its interpreter");
  writeFileSync(absolute, text.replace("--expected-python 3.11 --provenance publish ", ""));
  repin(root, path);
});

negative("an unrecorded absent live Echo fails even when repinned", /must be recorded, never assumed/, (root) => {
  const path = "scripts/verify-published-release.py";
  const absolute = resolve(root, path);
  const text = readFileSync(absolute, "utf8");
  assert.ok(text.includes("credentials_absent"), "fixture no longer records absent live Echo configuration");
  writeFileSync(absolute, text.replaceAll("credentials_absent", "unspecified"));
  repin(root, path);
});

negative("granting re-verification a credential fails even when repinned", /re-verification must stay credential-free/, (root) => {
  const path = ".github/workflows/verify-release.yml";
  const absolute = resolve(root, path);
  const text = readFileSync(absolute, "utf8");
  const anchor = "      - name: Verify registry bytes and both installed artifacts on CPython 3.11\n        if: ${{ !cancelled() }}\n";
  assert.ok(text.includes(anchor), "fixture no longer contains the first re-verification step");
  writeFileSync(absolute, text.replace(anchor, `${anchor}        env:\n          SOLVERAPI_API_KEY: \${{ secrets.SOLVERAPI_API_KEY }}\n`));
  repin(root, path);
});

negative("giving re-verification the publishing environment fails even when repinned", /must not enter the protected publishing environment/, (root) => {
  const path = ".github/workflows/verify-release.yml";
  const absolute = resolve(root, path);
  const text = readFileSync(absolute, "utf8");
  const anchor = "  verify:\n    runs-on: ubuntu-24.04\n";
  assert.ok(text.includes(anchor), "fixture no longer contains the re-verification job header");
  writeFileSync(absolute, text.replace(anchor, `${anchor}    environment: pypi-publish\n`));
  repin(root, path);
});
