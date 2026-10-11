# container-image-builds

## Scope

This repository owns shared runtime image definitions and publishing workflows for Ploinky and its agents. Application source belongs to its source repository. Pinned checkouts under `sources/` are build inputs and must not be edited.

## Mandatory Reading Order

Read `README.md`, `docs/index.html`, `docs/specs/DS001-coding-style.md`, and `docs/specs/matrix.md`. Use `docs/specs/DS003-main-behavior.md` for publication responsibilities. Before changing an image, read its Dockerfile, source lock, helpers, publishing workflow, and relevant tests.

## Current Skill Catalog

This repository distributes image definitions and verification helpers, not an agent skill catalog.

## Repository Rules

Keep documentation in English and ground claims in the selected workflow and implementation. Preserve exact source revisions, image digests, native proofs, and acceptance-receipt checks. Build, publication, promotion, and consumer adoption are separate operations requiring their applicable authorization. Never expose credential values in documentation, logs, or evidence. Preserve the configured human Git identity and omit tool attribution.

## Runtime Defaults

Use Node.js `.mjs` modules with built-ins for new helper code unless the image requires an existing shell or C interface. Record dependency choices in `dependencies.md` and image source locks. Inspect test side effects before execution. Static tests do not establish runtime image acceptance, and documentation validation must not publish images or move registry tags.

## Key Paths

`images/` holds Dockerfiles and image-specific helpers. `.github/workflows/` defines inputs, guards, credentials, and publication steps. `tests/` contains Node tests; `tests/fixtures/` contains their data. `docs/operations.html` explains publication boundaries and `docs/wiki.html` defines candidate, promotion, and acceptance-receipt terminology.
