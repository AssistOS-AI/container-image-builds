# Dependency record

## Ploinky Box library bundles

Node.js 24 is the runtime prerequisite. The image uses the immutable Node image
declared in `images/ploinky-box/Dockerfile`; library preparation and the
functional smoke use only Node built-ins, and publication verification adds only
the selected Ploinky source's dependency-free contract modules. Tests use
`node --test`. These checks add no npm or Python dependency.

The promotion-only workflow (`promote-ploinky-box-candidate.yml`), its verifier
`verify-promotion.mjs` and the receipt producer `acceptance-receipt.mjs` are
likewise Node built-ins only. They call the runner's `gh` and `docker buildx
imagetools` and reuse the already pinned GitHub actions of the publish workflow.

AchillesAgentLib is a required runtime library when the workspace has no local
checkout, and the MCP SDK is always supplied by the image. Their sources are
[AssistOS-AI/AchillesAgentLib](https://github.com/AssistOS-AI/AchillesAgentLib)
(package `ploinky-agent-lib`) and
[AssistOS-AI/MCPSDK](https://github.com/AssistOS-AI/MCPSDK) (package
`@modelcontextprotocol/sdk`, imported by Ploinky as `mcp-sdk`). The libraries
implement Ploinky's shared agent and MCP interfaces; duplicating them in the
image repository would create an incompatible independent implementation.
Bundling them is part of the requested offline Box fallback.

There is no manually maintained pin. Each publication resolves, once and before
the native builds fan out, the remote symbolic default branch and its HEAD
commit for every library that has no exact commit input, and both architectures
build that one frozen pair. An exact commit can be supplied for either library
(`agentlib_commit`, `mcp_sdk_commit`) to reproduce a source selection. The image
does not use Ploinky's dependency lock, and Ploinky compares no library
revision.

Each publication is its own dependency and license review, for the commit it
resolved. Before promotion, each resolved commit needs all of the following:

- The packaging checks of `images/ploinky-box/prepare-libraries.mjs` pass: the
  checkout is exactly the selected commit and clean, the package declares no
  runtime, optional, or peer dependencies, and every consumed entry exists. A
  library that starts to need dependencies or build output needs an explicit,
  reproducible preparation step in the image build first; an unbuilt source
  tree is never packaged.
- Every license and notice file is preserved, and a package that declares a
  license still ships one. The complete license and copyright notice of
  AchillesAgentLib (MIT, AssistOS-AI) remains at `/opt/ploinky-agentlib/LICENSE`
  and must be retained in redistributed copies and substantial portions. The MCP
  SDK's license files, if its repository has any, are preserved in its package
  the same way.
- Both native architecture builds pass, including the image's library `smoke`
  and negative `self-test`.
- Publication evidence passes: provenance equal to the frozen selections, the
  smoke covering every entry the selected Ploinky source consumes, and the
  exact image digests.

Preparation removes only Git metadata and seals the source as root-owned files
without write permission, preserving executable bits and every source and
license file. No library code is patched. The AchillesAgentLib source is at
`/opt/ploinky-agentlib` and its provenance record at
`/usr/local/share/ploinky/agentlib/runtime-contract.json`; the MCP SDK is at
`/usr/local/lib/ploinky/mcp-sdk` with its record at `.ploinky-box-mcp-sdk.json`.
The full sources remain available in the image without relying on a hidden host
checkout. The provenance records are informational build attribution; the
libraries carry no content hash and the image never records its own digest.

Startup validates a local source first, or checks that the image's package
exists with the entries Ploinky consumes. A missing or unusable package fails
with an AgentLib diagnostic; install a compatible Box image or provide a valid
local workspace checkout. Runtime startup never installs these dependencies.
Removing the image copy would remove the requested operation without a host
checkout, so there is no equivalent smaller replacement in the current scope.

The inherited container toolchains, base images, and native WebTTY dependency
remain pinned and documented in `images/ploinky-box/Dockerfile` and the Ploinky
Box sections of `README.md`. This change does not add packages to those
inherited toolchains.
