# Dependency record

## Bizanso runtime

`images/bizanso-agent/sources.lock.json` pins the Ploinky Node base digest and the public multilingual-e5-small model revision, dtype, and dimensions. Its package lock pins Transformers.js 4.3.1 (Apache-2.0) and the transitive ONNX Runtime dependency with npm integrity records. Runtime inference is CPU-only and offline. `poppler-utils`, `antiword`, LibreOffice Writer/Impress, and `fonts-liberation` are installed in the image for local extraction. Their distribution notices remain in the Debian packages; npm package notices remain in `node_modules`. The helper and verification code uses Node built-ins plus the pinned inference package. No private application checkout or private-source credential is a build input. Removing the model or native inference dependency would remove offline readiness; removing document tools would remove the supported legacy document extraction paths.

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

## local-llm Vulkan child

`images/local-llm/Dockerfile.vulkan` adds Mesa 25.3.6 and the llama.cpp b11159
Vulkan release to both proven CUDA parents. Both source locks pin the asset
URLs, sizes and SHA-256 hashes, Debian snapshot `20261001T000000Z`, direct
builder package versions and the Vulkan loader/tool versions. The arm64 and
amd64 builder locks differ where Debian publishes architecture-specific
package revisions. No global package installation is needed.

Mesa provides RADV and Venus; neither a loader alone nor the existing CUDA
binary implements those drivers. LLVM, Gallium and software Vulkan drivers are
disabled. The three vendored patches come from COPR build 10236391,
`slp/mesa-libkrun-vulkan`, in its original Patch20/21/22 order. The source RPM
hash and retained download URL are in the locks. Patch filenames are numbered
for that order; their bytes are unchanged. The originally advertised
`srpm-builds` URL returned 404, so the retained native-build result supplies the
same build's RPM. Updates require verifying the source archive's signature,
patch hashes, zero-fuzz applicability and both native final-child proofs.

Mesa's upstream source is <https://archive.mesa3d.org/mesa-25.3.6.tar.xz>.
The signing key is Dylan Baker's
`71C4B75620BC75708B4BDB254C95FAAB3EB073EC`, retained from that release's
`docs/release-maintainers-keys.asc`. The builder checks the signature and exact
fingerprint, uses the vendored keyring and the vendored detached signature
`images/local-llm/mesa-25.3.6.tar.xz.sig` (SHA-256
`6533c0eb2978a8eaca80ac187b390dc6266264fbf436c50652fd1a17cd024ca3`, the 119-byte
file published as `mesa-25.3.6.tar.xz.sig`; vendored because the upstream host
intermittently refused CI connections) and retains `docs/license.rst` at
`/opt/local-llm/vulkan/licenses/mesa-license.rst`. Mesa's core license is MIT;
its source license document records component exceptions. Retain these
copyright and license notices when redistributing the drivers and patches.

The llama.cpp assets come from
<https://github.com/ggml-org/llama.cpp/releases/tag/b11159>. llama.cpp is MIT;
the release archive's license material stays in `/opt/llama.cpp-vulkan`.
Debian's Vulkan loader is Apache-2.0, with notices under
`/usr/share/doc/libvulkan1/copyright`; `vulkan-tools` has its own packaged
copyright file. Debian supplies the C/C++ toolchain, Meson, Ninja, Python with
Mako/YAML/packaging, glslang and SPIR-V tools for compilation. Their package
versions are pinned, and the isolated builder is discarded. Mesa's transitive
runtime library closure is established by `ldd` in the final-child proof.

The proof uses Bash, Node.js built-ins and Python 3's standard-library tar
reader, invoked with `python3 -I`. Python avoids extracting an exported root
filesystem or adding a tar-reader dependency to the Node helpers. It checks
availability before creating proof containers. The helper removes only the
containers it created by exact ID. A missing runtime library, modified parent
file, changed CUDA resolution or wrong contract fails acceptance. Replacing
Mesa or Python requires equivalent driver support and archive checks.

The publishing workflow's `LOCAL_LLMS_COMMIT` pins the local-llms commit whose
agent imports the `pworker` engine package. The install-check job installs that
package on the host with `npm --prefix local-llm ci`, from the commit's own
lockfile and `.npmrc`, before it mounts the tree read-only at `/code`.
Static tests and local arm64 proof do not establish registry publication,
compressed image growth, AMD hardware support or Apple GPU inference.

The pinned parents already contain two OpenGL symlinks per architecture,
`/usr/lib/{aarch64,x86_64}-linux-gnu/dri/kms_swrast_dri.so` and `swrast_dri.so`, both
pointing to `libdril_dri.so`. Acceptance allows exactly those inherited paths
with unchanged type, mode, owner and target. Added `swrast` paths, lavapipe
libraries/ICDs and Intel Vulkan drivers still fail the final-child proof.

## OnlyOffice, LiveKit, and Egress native archive publication

`scripts/oci-layout-index.mjs` describes single-platform OCI layouts, verifies
their blobs and expands gzip layers with `node:zlib` to check their diff IDs,
proves a loaded image against its layout, and assembles the two-platform index.
It rejects layer compression it cannot expand with built-ins. It uses only Node built-ins and runs with the Node.js that
GitHub's `ubuntu-24.04` and `ubuntu-24.04-arm` runners provide; its tests use
`node --test` and temporary synthetic layouts.

Native jobs use only Buildx, which exports each build both as an OCI layout and
into the local daemon. The publish job installs `skopeo` from the runner's
Ubuntu 24.04 archive, as these workflows already did, and uses it only to copy
the verified layout to Docker Hub with `--preserve-digests`. Building on native
runners removes the QEMU action and the inline Python archive verifier that the
emulated multiplatform builds required. No npm or Python dependency is added.

## ScriptaHub processing runtime

The ScriptaHub image retains the pinned `ploinky-node` base and adds distro-managed LibreOffice Writer, QPDF, Poppler, Ghostscript, Chromium, FFmpeg, SoX, espeak-ng, libsndfile, fonts and Python venv/build tools. ScriptaHubAgent owns the thirteen skill sources, their npm lockfiles and its build-time preparation/verification scripts. The image installs the packages before startup; workflow execution never downloads missing libraries. Native PDF/model files are validated against the skill's committed size/SHA-256 inventory. Native distribution notices and the declared Eigen source archive are retained. The currently supplied native set is Linux ARM64.

Local audio uses the skill's CPU Kokoro, Qwen and Piper setup programs. The ARM64 Qwen deployment selects the matching PyPI `torch==2.10.0` and `torchaudio==2.10.0` CPU distributions; the Python setup records its complete resolved package set and selected model revision. Cloud provider credentials are not build inputs and are never included in the image. Final runtime doctors run as uid 1000. Real conversion/synthesis and the private `agentExec` sandbox remain distinct native acceptance gates.
