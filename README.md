# Millwork Solver for Python

`millwork-solver` is the Python client for the Millwork API. It provides
separate synchronous and asynchronous clients:

```python
from millwork_solver import AsyncSolver, Solver
```

This repository carries reviewed release artifacts. Availability is established
only when the exact version resolves from PyPI and its registry bytes and
installed behavior pass the retained verification matrix; repository contents
alone are not availability evidence.

The supported candidate matrix is CPython 3.11, 3.12, 3.13, and 3.14. The
package is licensed under Apache-2.0.

## Repository boundary

This is a purpose-built public publishing repository. The release candidate is
represented by the exact wheel and source distribution in `dist/`; the
workflow never rebuilds them. `export-manifest.json` records their hashes and
the closed publishing-export inventory. The exact repository support overlay is
validated separately from the retained release artifacts.

See [PUBLISHING.md](PUBLISHING.md) for the operator-only release boundary.
For non-sensitive questions, see [SUPPORT.md](SUPPORT.md). Report sensitive
security concerns through the route described in [SECURITY.md](SECURITY.md).
