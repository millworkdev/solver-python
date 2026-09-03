# Publishing boundary

Publishing is operator-only. A pull request, merge, green CI run, or prepared
export does not authorize a PyPI upload.

The manual `.github/workflows/publish.yml` workflow may be dispatched only
after all of these external gates are complete:

1. the `pypi-publish` GitHub environment exists and requires operator review;
2. the PyPI pending Trusted Publisher is bound to repository
   `millworkdev/solver-python`, workflow `publish.yml`, environment
   `pypi-publish`, and project `millwork-solver`;
3. the operator computes the canonical payload for the exact reviewed public
   commit, target, actions, and expiry, then posts its SHA-256 in a durable
   public comment;
4. the dispatch supplies that comment URL, its exact creation time, the expiry,
   exact commit and version, plus the canonical SHA-256 printed by
   `scripts/check-publish-preconditions.mjs --print-authorization-payload`.

The canonical payload binds the digest to the reviewed export commit and
manifest, retained packet and artifact hashes, repository, workflow,
environment, project, version, dispatch actor, two allowed actions, and one
attempt. A well-formed but unrelated digest is refused. The protected
environment approval remains the execution authority.

The comment reference and creation time are deliberately excluded from the
hash so the operator can post the digest before GitHub assigns them. The guard
then resolves the reference through the public GitHub API, requires exact
operator `matt783`, requires the returned creation time to equal the dispatch
input, rejects an edited comment, and enforces creation < expiry <= 24 hours.
Its exact JSON body must name the authorization schema and canonical digest.
A missing comment, different author, or different digest is refused before the
registry is touched.

The public bridge contains only a public-safe assurance ID and digest derived
from the private final source record. Raw private source commit and tag values
remain in that private record. The workflow remains closed while the assurance
or reviewed public export commit is pending.

The workflow refuses a version that already exists, uses OIDC without a PyPI
token, uploads only the two hash-bound files already in `dist/`, and performs
no build. After upload it downloads the registry files, compares their hashes,
and clean-installs the wheel and source distribution on CPython 3.11–3.14,
exercising the installed public surface without a socket. None of that needs a
credential, so all of it runs: both artifacts within every runtime, and every
runtime, even when an earlier one fails. The evidence is uploaded before a
final step asserts the retained set is complete, bound to the runtime and
artifact that produced each record, and consistent with the attested hashes.

The synchronous and asynchronous Echo receipts are the one post-publish proof
that does need credentials: an API key secret and a base URL variable on this
repository. They are recorded only when both are configured. When either is
absent the evidence records the live Echo as not run, with that reason and the
names of the absent settings, so an unconfigured runner can never read as a
live proof that did not happen. A live Echo that runs and fails still fails
the workflow, after its evidence is written.

`.github/workflows/verify-release.yml` re-proves the credential-free half on
demand for a version that is already released. It publishes nothing, holds
read-only permission, requests no OIDC identity, and never enters the
protected environment.

If the project name is unavailable, the publisher binding is wrong, the
environment is absent, a registry response is ambiguous, or any hash differs,
stop. Do not fall back to a token and do not replace an existing version.

Bad releases are never overwritten. A later, separately authorized recovery
may yank a bad version with a reason and publish a new fixed version.
