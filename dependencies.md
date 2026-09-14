# Dependency record

## Ploinky Box AgentLib bundle

Node.js 24 is the runtime prerequisite. The image uses the immutable Node image
declared in `images/ploinky-box/Dockerfile`; the bundle preparation,
verification, and publication checks use only Node built-ins and selected
Ploinky source modules. Tests use `node --test`. These checks add no npm or
Python dependency.

AchillesAgentLib is a required runtime library when the workspace has no local
checkout. Its source is
[AssistOS-AI/AchillesAgentLib](https://github.com/AssistOS-AI/AchillesAgentLib).
The exact revision is resolved from the selected Ploinky source's
`ploinky-box/dependencies.lock.json`, currently
`214ba4c3d64fd857361bf8ab56a5640c5efb30e0`. That revision declares no npm
dependencies. No package installation or runtime download is required.
The library implements Ploinky's shared agent interfaces; duplicating it in the
image repository would create an incompatible independent implementation.
Bundling the existing library is part of the requested offline Box fallback.

The publication workflow checks out the exact lock commit, checks its clean
Git state, and copies it into an isolated image builder. Preparation records a
content fingerprint; sealing removes `.git` and write permissions while
preserving executable bits and all source and license files. No library code
is patched. The sealed source is at `/opt/ploinky-agentlib`, and immutable
metadata and verification modules are at `/usr/local/share/ploinky/agentlib`.
The full source remains available in the image without relying on a hidden
host checkout.

The exact pin is MIT licensed, copyright 2025 AssistOS-AI. The complete license
and copyright notice remains at `/opt/ploinky-agentlib/LICENSE`; it must be
retained in redistributed copies and substantial portions. Future lock updates
must review package dependencies and licenses, use a clean immutable checkout,
rebuild both native architectures, and pass build and publication evidence
checks before promotion. A future pin with dependency requirements needs an
explicit reproducible dependency preparation policy.

Startup validates local source first, or checks the image bundle's entries,
fingerprint and locked commit. Missing, modified or incompatible bundles fail
with an AgentLib diagnostic; install a compatible Box image or provide a valid
local workspace checkout. Runtime startup never installs this dependency.
Removing the image bundle would remove the requested operation without a host
checkout, so there is no equivalent smaller replacement in the current scope.

The inherited container toolchains, base images, MCP SDK and native WebTTY
dependency remain pinned and documented in `images/ploinky-box/Dockerfile` and
the Ploinky Box sections of `README.md`. This change does not add packages to
those inherited toolchains.
