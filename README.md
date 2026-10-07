# container-image-builds

Central Docker Hub image build definitions for the Ploinky/AssistOS workspace.
This repository owns the Dockerfiles and GitHub Actions workflows that publish
shared runtime images to the `assistos` Docker Hub organization.

## Images

| Image | Source repo | Build context | Dockerfile | Workflow |
| --- | --- | --- | --- | --- |
| `assistos/ploinky-node:24-trixie-tools` | this repo | `images/ploinky-node` | `images/ploinky-node/Dockerfile` | `publish-ploinky-node-image.yml` |
| `assistos/onlyoffice-agent:9.3.1` | this repo | `images/onlyoffice-agent` | `images/onlyoffice-agent/Dockerfile` | `publish-onlyoffice-agent-image.yml` |
| `assistos/llm-runtime-cpu:cpu-arm64-smoke` | this repo | `images/llm-runtime-cpu` | `images/llm-runtime-cpu/Dockerfile` | `publish-llm-runtime-cpu-image.yml` |
| `assistos/umami-agent:umami-stack` | this repo | `images/umami-agent` | `images/umami-agent/Dockerfile` | `publish-umami-agent-image.yml` |
| `assistos/local-llm:latest` (multi-arch: amd64 reused, arm64 built for NVIDIA GB10; `latest` moves to a proven candidate index only when dispatched with `promote_latest`) | this repo | `images/local-llm` | `images/local-llm/Dockerfile` (amd64), `images/local-llm/Dockerfile.arm64` (arm64) | `publish-local-llm-image.yml` |
| `assistos/search-agent:searxng-browser` | `AssistOS-AI/proxies` | `searchAgent` | `images/search-agent/Dockerfile` | `publish-search-agent-image.yml` |
| `assistos/opencode-free-agent` (digest-pinned candidates) | `AssistOS-AI/proxies` | `opencode-free` | `images/opencode-free-agent/Dockerfile` | `publish-opencode-free-agent-image.yml` |
| `assistos/roboteam-agent:runtime` | this repo | `images/roboteam-agent` | `images/roboteam-agent/Dockerfile` | `publish-roboteam-agent-image.yml` |
| `assistos/roboteam-desktop:runtime` | this repo | `images/roboteam-agent` | `images/roboteam-agent/Dockerfile.workstation` | `publish-roboteam-agent-image.yml` |
| `assistos/roboteam-browser:runtime` | this repo | `images/roboteam-agent` | `images/roboteam-agent/Dockerfile.browser` | `publish-roboteam-agent-image.yml` |
| `assistos/bwrap-runner:node24-python-trixie` | `AssistOS-AI/basic` | `bwrap-runner` | `images/bwrap-runner/Dockerfile` | `publish-bwrap-runner.yml` |
| `assistos/livekit-server-agent:webmeet-infra` | `AssistOS-AI/AssistOSExplorer` | `liveKitServerAgent` | `images/livekit-server-agent/Dockerfile` | `publish-livekit-server-agent.yml` |
| `assistos/soul-gateway:node24-sqlite` | `AssistOS-AI/proxies` | `soul-gateway` | `images/soul-gateway/Dockerfile` | `publish-soul-gateway-image.yml` |
| `assistos/ploinky-box:latest` (`runtime` compatibility alias) | this repo, an immutable `AssistOS-AI/ploinky` commit, and the `AssistOS-AI/AchillesAgentLib` and `AssistOS-AI/MCPSDK` commits frozen once per publication | repo root; rootless nested-Podman appliance with the canonical Ploinky entrypoint, bundled AchillesAgentLib and MCP SDK, and integrated cloudflared | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` (build, candidate, optional promotion of its own build); `promote-ploinky-box-candidate.yml` (promotion of an already built and accepted candidate) |

The former `assistos/default-local-llm` image is retired and no longer built
here; already published tags are not deleted from the registry. The optional
`llm-runtime-cpu` image remains available.

The `bwrap-runner` workflow checks out exact full-SHA `basic`, `copilot-agents`,
and `AchillesCLI` inputs under `sources/`; the latter two supply the Open
Interpreter and GPTResearcher consumer gates. Those two SHAs are explicitly
prepublication consumer-code inputs: they contain the ABI/disposition adapters
while retaining the existing privileged declarations and mutable image
references. The workflow neither requires nor creates the later digest-pin and
privilege-removal commits, so publication remains the input to those consumer
changes rather than depending on them. The `livekit-server-agent`
workflow also checks out its source repository under `sources/`. The
`ploinky-box` workflow checks out Ploinky at an exact commit. Its prerequisite
job freezes the AchillesAgentLib and MCP SDK selections once (see
[Ploinky box publication](#ploinky-box-publication)), and each native build
checks out exactly those commits without persisted credentials. The image
consumes the canonical Box entrypoint and the exact WebTTY native package,
lockfile, and self-contained probe from Ploinky; it packages both libraries with
its own tools. Router and application source remain on the read-only runtime
mount. Native architecture images are published by immutable digest.

The LiveKit workflow accepts only the exact 40-character commit SHA at the
current tip of `AssistOSExplorer/main`, its default branch. The checkout lives at
`sources/AssistOSExplorer`; both builds use its `liveKitServerAgent` directory
with this repository's centralized Dockerfile. It builds and smoke-tests the
local architecture before authenticating and publishing the multiarchitecture
image.
Its three base images are pinned by manifest-list digest, and Ubuntu package
resolution is pinned to a dated repository snapshot with exact direct-package
versions. The pinned `libc-bin` package and both build-time and workflow smoke
gates guarantee that the startup script's `getent` dependency is present.

Merge the relocated `liveKitServerAgent` source into `AssistOSExplorer/main`
and integrate this workflow change before removing the old source from
`webmeetInfra`. Select the resulting current `AssistOSExplorer/main` SHA when
dispatching a future build. The source move itself does not require publication
or a change to existing consumer image digests.

The LiveKit workflow keeps its stable `webmeet-infra` release tag and
also exposes the pushed multiarchitecture manifest digest as the `publish` job's
`digest` output. Each workflow validates that build output as an exact sha256
digest and writes the resulting `docker.io/assistos/...@sha256:...` reference
to both the log and GitHub job summary. Publishing and pinning consumer
manifests remain separate authorized operations.

## Umami agent supply chain

Umami 3.2.0 is compiled from its checksum-pinned upstream source plus the
explicit `login-query-cache` and `metadata-assets` source patches with
`BASE_PATH=/base-agent-additional-server/umamiAgent/3000`. This matches the
existing Router publication. The UmamiAgent ingress restores that prefix after
Router forwarding, while Next listens only on `127.0.0.1:3001` behind the agent's
port 3000 ingress. A runtime environment change cannot substitute for this
build-time Next configuration.

`images/umami-agent/sources.lock.json` records every selected image, source
archive, source lockfile, and package-manager artifact. No workflow input can
override those selections.

| Input | Immutable selection | Contract |
| --- | --- | --- |
| Runtime and build tools | `docker.io/assistos/umami-agent@sha256:5ca78a8263f000bfa6f5039e225452f8a4ec6526c52157955dc83454128c8bf6` | Both native manifests and image configs are pinned in the lock. This retains Node 22.23.1, Bun 1.3.14, PostgreSQL 18.4, and the existing MCP installation. |
| Umami source | `umami-software/umami` commit `2f6e2b5ff256862a081d9e74bed18a42ebf795e3` (3.2.0), with the recorded login and metadata patches | The archive and original source hashes are verified before patching. Each patch script and every resulting source file hash are pinned separately before the upstream `build-docker` script runs. |
| Dependencies | pnpm 10.15.1 and upstream `pnpm-lock.yaml` SHA-256 `b5ba02abd9e346194926658cbfecd95fe4c0a5c765d653a745cf3deb06ec8171` | The package manager archive is checksum-pinned; installation is frozen. Production dependencies and Prisma are retained for the normal database migration command. |
| `MadsNyl/umami-mcp` | Commit `3ab73beda2db0ebffb0b07439b218ef562107520` | The immutable runtime retains its frozen Bun installation; publication verifies its inherited revision and lock labels. |
| GeoIP | Existing `/app/geo/GeoLite2-City.mmdb` from each pinned runtime manifest | Upstream `SKIP_BUILD_GEO=1` avoids a mutable download. The seal verifies the copied database matches the original bytes. |

The final stage removes the old `/app` completely and installs the source-built
standalone server, static assets, public files, scripts, Prisma artifacts, and
production dependencies. `/app/ploinky-umami-build.json` binds the compiled
base path, upstream source revision, applied patch identities and receipt,
lockfile, server, tracker, and GeoIP hashes. The seal also checks the actual
patched build source. The
image also carries the source lock at
`/usr/local/share/ploinky/umami-agent-sources.json`. The retained runtime base
and rebuilt application ancestry are recorded separately.

The login patch cancels only an outstanding `['login']` verification and seeds
that query with the successful login response's user before publishing the user
or navigating. This prevents an earlier or late verification 401 from forcing
a full login-page reload after authentication. Each native build executes the
actual original and patched submit handlers against its frozen Query Core
5.101.0 dependency, proving both failure cases and preservation of unrelated
queries. The image is explicitly labeled as modified upstream source.

The metadata patch preserves that login correction and separately prefixes the
layout's six icon/manifest links, explicitly declares the published browser
configuration, and prefixes the manifest icons and browser configuration tile.
Only the three pinned source files are changed before compilation. Native
runtime proof fetches all ten declared and nested metadata resources, verifies
their media types and exact source/output bytes, and requires the unprefixed
paths to return 404. No compiled asset or Router response rewriting is used.

Publication is manual and builds on native amd64 and arm64 runners. Each exact
native digest must pass a network-isolated, UID 1000, capability-free runtime
gate: initialize disposable PostgreSQL, run real migrations, start Next only
on loopback, fetch the prefixed login, scripts/styles/fonts, and metadata assets,
verify heartbeat and authenticated API calls, and fetch the prefixed tracker.
The workflow assembles exactly those proven native manifests and their
provenance/SBOM attestations into a run-specific candidate index, and uploads
both native proofs and the immutable index. `promote_stable=false` is the
default; only an explicit `promote_stable=true` moves `umami-stack` after both
gates pass. Consumers adopt the resulting immutable digest separately.

## SearchAgent runtime

`docker.io/assistos/search-agent:searxng-browser` layers Chromium, a pinned
SearXNG source revision, its Python environment, and the pinned Puppeteer
runtime onto the standard Ploinky Node image. System packages and `/opt`
content are created only while building the immutable image as root. The
published runtime restores UID/GID `1000:1000`, so enabling SearchAgent never
requires package-manager or system-directory privileges.

## RoboTeam nested Podman runtime

`docker.io/assistos/roboteam-agent:runtime` is the outer runtime for RoboTeam. It
uses the immutable official Podman stable multiarchitecture index as its
Podman 5.8.7 provider and the exact Ploinky Node multiarchitecture base recorded in
`images/roboteam-agent/sources.lock.json`. It provides Node/npm, Podman,
Bubblewrap, fuse-overlayfs, pasta, curl, Git, and Bash. It contains neither a GUI
nor Codex.

`docker.io/assistos/roboteam-desktop:runtime` derives from the digest-pinned
LinuxServer Ubuntu XFCE Webtop base. It contains Node/npm plus the X11, AT-SPI,
window-control, screenshot, and MCP launch support required by desktop control.
It does not contain computer-use-linux or Supergateway.
`docker.io/assistos/roboteam-browser:runtime` derives from the separate
digest-pinned LinuxServer Chromium base and contains Node/npm plus the MCP/CDP
launch service. It does not contain Playwright MCP. RoboTeam resolves these
tools and Codex at first use, prepares validated persistent generations under
its `/data/tool-cache`, and mounts exact generations read-only into the relevant
runtime. Consequently, tool releases can advance without rebuilding these large
images.

The root-owned read-only contract is
`/opt/roboteam-runtime/contract-v6`, containing `roboteam-runtime-v6` followed
by one newline. Inner image storage is configured under `/data/podman/images`
with fuse-overlayfs and `force_mask="0700"`; disposable container state stays
in `/var/lib/roboteam-podman/storage` with `transient_store` enabled. The image's
`roboteam-podman-init` helper mounts `/var/lib/roboteam-podman` as a private,
2 GiB-limited tmpfs before installation and on every service start; runroot is
`/var/lib/roboteam-podman/run`. Space is allocated on demand. This prevents
FUSE-on-FUSE writable layers and keeps conmon sockets off macOS virtiofs, allowing protected
directories and merged-/usr links in the persistent image cache. GUI images
pre-create ToolCache and Podman default mount targets, including `/install` and
`/run/secrets`, so crun does not create them through the nested overlay. SUID
namespace helpers are removed.

The `nested` smoke mode runs a real inner Alpine container through `pasta` with
private IPC and 1 GiB shared memory. It is intended for a Ploinky Box or another
runtime that supplies `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, and `/dev/net/tun`;
GitHub-hosted Docker does not provide the required nested mount behavior.
`scripts/smoke-roboteam-gui.mjs`, streamed to Node inside the deployed RoboTeam
container, additionally starts an isolated diagnostic Browser with real workspace
and tool-generation mounts and requires GUI HTTP 200, Chromium CDP and MCP
responses. It removes only its own diagnostic container and home, without
starting a workflow or coding agent. Its optional `--isolated-storage` mode is
for comparison against an older deployment; normal mode uses the deployed storage.

Publication runs source checks, a capability-free outer contract smoke, and
GUI runtime smokes that prove Node/npm and the launch adapters are present while
the dynamic tools are absent. It then uses Buildx and QEMU to publish amd64 and
arm64 directly under the three operator-managed `runtime` tags. The workflow does not attempt the nested smoke, use
privileged mode, or mount a host engine socket.

### Local RoboTeam development images

Development does not require publishing the three rolling tags. From the
workspace host, run one of these commands:

```bash
node container-image-builds/scripts/install-roboteam-local.mjs agent
node container-image-builds/scripts/install-roboteam-local.mjs desktop
node container-image-builds/scripts/install-roboteam-local.mjs browser
node container-image-builds/scripts/install-roboteam-local.mjs all
```

The owned Ploinky Box must already be running, and RoboTeam must be running
before a GUI target can be transferred.

The host launcher proves exact Box ownership, then executes the build inside
that Box so the outer RoboTeam image lands directly in Ploinky's Podman storage.
Desktop and browser images are streamed from the Box image store into the
running RoboTeam container's nested Podman store without a registry or an image
archive on disk. The installer accepts exactly one managed RoboTeam runtime and
finishes with `reinstall roboTeamAgent`, so active robot sessions are stopped
and subsequent sessions use the new local images. Local builds are native to
the development host architecture. Missing base images may be pulled once and
are reused afterward; the built RoboTeam images are never pulled or pushed by
this loop. The publication workflow remains the source of multiarchitecture
images.

## Node and Python Git transport

The Node and Bubblewrap images use the pinned official Node 24.20.0 Trixie
index `sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0`.
Trixie's Git-linked libcurl preserves TLS 1.3 tickets with the default TLS
configuration. The images require no HTTP/1.1 override or TLS interception.
The Bubblewrap image combines Node with official Python 3.12.14 Trixie index
`sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`.
Python 3.12 satisfies both GPTResearcher and Open Interpreter's pinned tiktoken
wheel compatibility; distro Python 3.13 is not installed. `/usr/bin/python3`
is created only when absent and points to the official Python interpreter.
Both base indices are recorded in Bubblewrap's publication evidence.

Each native architecture gate runs `scripts/smoke-git-transport.mjs` inside
the exact published digest. The probe inventories Git's actual HTTPS helper
and linked libraries, clears inherited Git, npm, proxy and loader overrides,
and isolates Git system/global and npm user/global configuration. It requires
anonymous HTTP/2 negotiation for default and explicitly selected HTTP/2
`ls-remote`, clone and fetch against Soplang and GPTResearcher, followed by
each mode's cold npm installation of a small public Git fixture. The npm lock
must contain only that fixture and its reviewed commit; this probe never
downloads MCPSDK. JSON evidence retains operation, negotiation and response
status on failure without recording credentials or request headers.

The Node workflow builds amd64 and arm64 natively, checks tools and transport
by digest, then assembles only those successful members into a run-scoped
candidate index. It always reports the immutable candidate. Dispatching with
`promote_stable=true` additionally moves `24-trixie-tools` after those gates.
The old Bookworm tag is never reused for a Trixie image. Consumers must be
updated explicitly to the approved image digest.

## Bubblewrap runner publication

`publish-bwrap-runner.yml` accepts only exact 40-character commits for the
runner source and both consumer-source gates. There is no branch/ref fallback.
The consumer SHAs are evidence-only prepublication code selections, recorded as
`prepublication-code-only`; they do not authorize or perform manifest pinning.
Native `ubuntu-24.04` amd64 and `ubuntu-24.04-arm` jobs each build and push one
architecture by digest without moving the stable tag. Each job requires
rootless Podman and runs the digest as its default UID/GID `1000:1000`, projected
with `keep-id:uid=1000,gid=1000`, with all capabilities dropped,
`no-new-privileges`, no host namespace options, and no unconfined profile. It
records the image's effective UID/GID, capability and namespace state, SUID
inventory, Bubblewrap mode/file capabilities, platform, pinned base image,
workflow/action identity, and every exact source commit.
Set-id and file-capability inventory covers private HOME as UID1000 and the rest
of the image separately with a read-only filesystem as UID0, with capabilities
dropped and no network. Neither traversal ignores errors. Actual transport,
native policy, and provider gates always use the image's nonzero identity.

The native gate has no skip path. It requires actual empty-proc production
execution with write, read-only-system-file, sibling/source, device, and
environment boundary assertions. Private proc must either pass the same
execution checks or produce canonical capability evidence that only empty proc
is available, together with a real private-only task rejection before state or
staged-file mutation. This matches ABI 2's `private-or-empty` default without
claiming private execution on a host that forbids it. Fixed network files use
private copies and `/dev` contains only four fixed devices; the policy never
binds outer proc or relaxes container confinement. The canonical healthcheck
and a representative staged runner task must also succeed networklessly. Separate
consumer gates prepare Open Interpreter with installation-only network access,
then require its networkless terminal
`PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE` disposition, and perform a real
GPTResearcher cold install in a networked container followed by import,
UI/readiness, and lightweight task-adapter checks in a separate networkless
container over the same HOME-owned persisted install; no writable `/opt` mount
is provided. Installation egress is not
task-time network authority.

Only after both architecture jobs upload their digest and evidence artifacts
does the assemble job create a run-scoped candidate index from exactly those
two digests and verify exact `linux/amd64` and `linux/arm64` membership. The
candidate digest is always reported. The `node24-python-trixie` convenience
tag moves only when dispatch explicitly sets `promote_stable=true`, and only
after all prior gates; no behavioral check occurs after promotion. Consumer
manifests must use the recorded `docker.io/assistos/bwrap-runner@sha256:...`
identity, never the convenience tag. The compatibility runner intentionally
retains privilege until this native proof exists and its later consumer update
pins the approved digest. The workflow uploads both per-architecture proof
directories and an assembled candidate evidence artifact containing the exact
index, source identities, member digests, base image, workflow run, and
multiarchitecture digest.

## Ploinky Box runtime

`docker.io/assistos/ploinky-box:latest` is the primary mutable release channel
for the outer appliance. An explicit stable promotion also moves `runtime` to
the same manifest digest for compatibility with older Ploinky installations.
Candidate publication leaves both channels unchanged. The image
supports native rootless Podman only;
it requires `/dev/fuse`, `/dev/net/tun`, the explicit unmask security option,
and no engine socket, privilege, added capabilities, or unconfined seccomp
profile. The image contains Podman, fuse-overlayfs, Node 24, npm/npx, Bash, Git,
SSH, curl, ffmpeg, Python 3, process/namespace tools, cloudflared, and the
rootless Netavark/pasta helpers. Its explicit interactive-shell baseline also
includes deterministic GNU text and file tools (`find`, `grep`, `sed`, `awk`,
`diff`, `patch`), JSON and transfer tools (`jq`, `wget`, `rsync`), common
archive utilities, `less`, `file`, `which`, `tree`, `nano`/`vi`, and network
diagnostics (`ss`, `ping`, `dig`, `host`, `nslookup`, `nc`, `netstat`, `lsof`).
The Dockerfile requires every advertised command during both native builds.
Ploinky source is mounted read-only at `/opt/ploinky`; the Dockerfile copies its
canonical `ploinky-box/entrypoint/ploinky-box-entrypoint` and the three exact
native-package inputs described below. It copies no Ploinky library, lock, or
verifier module, and it does not retain Router or application source, or a
separate image-repository entrypoint implementation.

The image owns both libraries. `images/ploinky-box/prepare-libraries.mjs` is the
builder-stage packaging tool. It requires each Git checkout to be exactly the
selected commit and clean, accepts only a package that ships without an install
step (no runtime, optional, or peer dependencies), and requires every file
Ploinky consumes. It then removes only `.git`, keeps every license and notice
file, and writes a build-generated provenance record, `ploinky.box.library/v1`,
with the library, package name and version, repository, resolved default branch
(`null` for an explicit commit), and commit. The image carries no content
hash of either library, no expected-revision policy, and no image label for
them; the provenance is informational. The image's own digest is never embedded.

The MCP SDK is packaged at `/usr/local/lib/ploinky/mcp-sdk` (package
`@modelcontextprotocol/sdk`, entry `exports["."]`, imported by Ploinky as
`mcp-sdk`) with its provenance at `.ploinky-box-mcp-sdk.json` in the package
root. Box startup performs no MCP SDK Git or npm operation: it transactionally
copies the packaged library into the workspace-backed dependency cache and
repairs a missing or partial cache copy from those local bytes.

AchillesAgentLib is packaged at `/opt/ploinky-agentlib`, with its provenance at
`/usr/local/share/ploinky/agentlib/runtime-contract.json`, outside the source.
Both trees are sealed as root-owned files that the runtime user cannot modify.

The image's own smoke, `/usr/local/share/ploinky/smoke-libraries.mjs`, runs as
the unprivileged runtime user with three commands. `inspect achillesAgentLib`
and `smoke` first prove the protected package layout and every consumed entry
without importing anything, so no library code runs from a package with a wrong
layout, owner, permission, identity, or missing entry. `inspect` then imports the
consumed modules to check their exports and reports the package version and,
when present, its provenance. `smoke` imports every module and export Ploinky
consumes, including `LLMAgents/openAiAgenticResponder.mjs` (`isOptOutModel`,
`runOpenAiAgenticResponse`), the JWT signing and verification exports, and every
MCP SDK member; it then runs an offline HS256 JWT round trip and one loopback
MCP tool call over `StreamableHTTPServerTransport` and
`StreamableHTTPClientTransport`. The protected layout is root-owned, not
group- or other-writable, without Git metadata, and without symlinks, except
that AchillesAgentLib may keep symlinks whose targets stay inside its package.
`self-test` builds disposable broken copies (no responder module, each missing
responder export, an SDK entry without `StreamableHTTPClientTransport`) and
proves `smoke` rejects each with the exact missing-entry or missing-export
error, not merely any failure that mentions the name. The Dockerfile runs `smoke` and
`self-test` in the final rootfs, and publication requires both on each native
architecture.

A valid `<workspace>/achillesAgentLib` checkout mounts read-only over the image
copy and takes precedence, including its uncommitted changes; the MCP SDK still
comes from the image. If that checkout is absent, Ploinky uses the image copy
without cloning on the host. An invalid local checkout remains an error.
Ploinky does not compare the image's library commits with any revision of its
own; the supplying image identity, not a commit, identifies the libraries, so
a different image is the way to change them. See [`dependencies.md`](dependencies.md)
for the libraries' dependency and license record.

The Podman base is pinned to the immutable multiarchitecture Quay OCI index
`quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964`.
Node is pinned to the official Node 24 Bookworm slim multiarchitecture index
`docker.io/library/node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`.
The cloudflared source is likewise pinned, and the Dockerfile verifies the
exact architecture-specific binary digest, version 2026.7.1, and
`--token-file` support. Both amd64 and arm64 are built on native runners.

WebTTY has no independent image or listener. Its exact `node-pty` 1.0.0
dependency is compiled in a compiler-only stage based on the pristine Box
rootfs. The distributable rootfs receives only the pruned production dependency
tree at `/usr/local/lib/ploinky/webtty/node_modules`, the self-contained probe,
and `/usr/local/share/ploinky/webtty/runtime-contract.json`. A real unprivileged
PTY probe proves absolute import, input, output, resize, exit, process identity,
and reaping during every native image build. The final stage also rejects
compiler, header, build-workspace, and npm-cache residue.

The private WebTTY native contract records schema
`ploinky.webtty.native/v1`, Node major 24/module ABI 137, architecture,
`node-pty` version, package-lock hash
`3eec51e517db1ba30c6ef523be83640cd0484b910adfa54a11692e020ea06a6a`,
the native-artifact hash, and the build source SHA. The source SHA is provenance
only; runtime compatibility never compares it.
This private capability evidence does not alter the unversioned Box marker,
image name, tags, labels, environment, volumes, entrypoint, user, workdir, or
network publication contract.

The final image is reconstructed from a prepared Podman filesystem through a
clean `FROM scratch` stage. Its metadata is exact:

| Field | Value |
| --- | --- |
| Image labels | None |
| Marker | `/etc/ploinky-box` contains exactly `assistos/ploinky-box` followed by one newline |
| User | `podman` |
| Environment | `USER=podman`, `HOME=/home/podman`, `PLOINKY_DISABLE_HOST_SANDBOX=1`, `container=oci`, `_CONTAINERS_USERNS_CONFIGURED=`, `BUILDAH_ISOLATION=chroot` |
| `PATH` | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Working directory | `/` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | Absent |
| Declared image volumes | Absent |

The image contains no workspace path. The supervisor mounts the selected host
workspace `W` read-write at the same absolute path `W` inside the Box, and gives
each created Box `--workdir W` and `PLOINKY_WORKSPACE_ROOT=W`. The entrypoint
rejects a missing root, a working directory other than the root, or a root that
does not resolve to itself before it prepares anything. Boxes and images from
the former fixed `/workspace` layout are incompatible and must be recreated.

The host workspace, reusable image content, and pinned dependencies outlive one
outer Box. Besides the workspace bind, the supervisor bind-mounts two
workspace-backed cache directories: `.ploinky/box/dependencies` at
`/opt/ploinky/node_modules` and `.ploinky/box/images` at
`/home/podman/.local/share/ploinky-images`. The workspace and both cache binds
survive stop, destroy, replacement, and recreation.

Everything else in the inner Podman store is disposable and is discarded with
the outer Box:

| Path | Lifetime |
| --- | --- |
| `/home/podman/.local/share/ploinky-images` | Workspace-backed host bind from `.ploinky/box/images`; downloaded image content only |
| `/opt/ploinky/node_modules` | Workspace-backed host bind from `.ploinky/box/dependencies`; pinned dependency cache |
| The selected workspace path | Durable host bind at the same absolute path; user and agent data |
| `/home/podman/.local/share/containers/storage` | Box writable layer; nested container records, writable layers, and inner named volumes |
| `/tmp/storage-run-1000` | Box tmpfs; reset on every startup |

The entrypoint renders `/home/podman/.config/containers/storage.conf` before the
first inner Podman call, pointing `imagestore` at the durable cache while
`graphroot` stays on the disposable writable layer with `transient_store`
enabled. Persistent agent data therefore belongs in workspace binds, never in
inner Podman named volumes.

The first mutating call from a markerless workspace creates only an empty host
`.ploinky` identity anchor so descendants converge on the same Box. Status is
read-only. Stop uses a dedicated in-box helper and remains available when
dependency state is missing or corrupt. Outer candidate and replacement cleanup
includes anonymous volumes only.

First boot generates a mode-restricted workspace master key, validates the
selected local AgentLib mount or the image's AgentLib, and materializes the image's MCP
SDK into the dependency cache without network access. The key never crosses from
the host, is not printed, and is excluded from nested agents. It remains stable
with the host workspace because it is stored under `<workspace>/.ploinky`.
Manual key edits and in-place rotation are unsupported; a new key requires a
distinct host workspace identity and migration of non-secret data only.

The Box publishes exactly loopback TCP on the selected host port to Router
`8080` and UDP `7882` to in-box `7882`. The private core listener stays on
loopback `8081` inside the Box and is never published. Custom-port output and
health probes use the external authority while the in-box Router remains on
8080. Entrypoint transport discovery writes the route/address JSON and effective
`host_containers_internal_ip` configuration as one rollback-safe pair. Neither
runtime-owned file is present in the immutable image, including any
`containers.conf` inherited from the pinned Podman base.

Runtime-definition changes are a hard cut. Stop and explicitly destroy an
incompatible Box before recreation; foreign exact-name containers or volumes
are rejected and never adopted. The entrypoint also rejects retained managed
nested containers without deleting or importing them. Inspect retained named
volumes before any manual recovery, and do not remove them as part of the normal
destroy path.

## Ploinky box publication

Manual dispatch requires one exact 40-character Ploinky commit in `source_ref`.
`agentlib_commit` and `mcp_sdk_commit` are optional exact 40-character commits.
The prerequisite job resolves each library that has no commit input from its
remote symbolic default branch with one `git ls-remote --symref` query, run
outside any checkout with only its own repository credential, and
freezes repository, branch, and commit for both libraries as job outputs, kept
as build-input evidence (`library-inputs.json`). Neither default branch is
assumed to be `main`, a missing or malformed symbolic `HEAD` fails the run, and
an explicit commit skips resolution for that library and records no branch.
Both native builds check out only the frozen commits, so a default branch that
moves after the prerequisite job cannot split the two architectures. This
reproduces the source selection of a publication, not its bytes. The workflow
verifies that the immutable Ploinky checkout, both library checkouts, and its own
image-definition checkout are clean and at the requested revisions.
`promote_stable=false` is the default; only an explicit `true` can move `latest`
and the `runtime` compatibility alias after candidate verification.

Each native architecture job builds the frozen pair by immutable digest, pushes one image,
and runs the image's own WebTTY `--verify` probe as UID/GID 1000 with no network, no
capabilities, no new privileges, and a read-only rootfs. Its retained evidence includes the exact
image configuration, probe result, sealed contract, source-probe fingerprint,
source and workflow commits, and run/attempt identity. The selected Ploinky
source validator must accept every PTY capability, and the image probe bytes,
source SHA, package lock, native architecture, and sealed contract must match.
The same confined runtime runs the library `smoke` and `self-test` and reads
both provenance records, retained as `library-smoke.json`,
`library-self-test.json`, and `library-provenance.json`. Publication requires
passing smoke and self-test results, a smoke that checked the protected package
layout rather than relaxing it, provenance equal to the frozen selections
(repository, branch, commit) with a package name and version, and a smoke whose
required entries cover every `AGENTLIB_REQUIRED_ENTRYPOINTS` entry of the
selected Ploinky source, so a new Ploinky consumer cannot ship without smoke
coverage. Both architectures must report the same libraries. The native and
candidate proofs, the uploaded evidence, and the workflow summary record
repository, branch, commit, and package version for both libraries next to the
externally observed image digests. Missing or failing library evidence prevents
candidate publication.
These package capability checks do not execute the full Box lifecycle, sibling
repository tests, or browser E2E; those acceptance gates remain separate.

The merge job revalidates both native evidence sets, requires distinct amd64 and
arm64 digests, and proves the run-scoped
`runtime-candidate-GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT` tag is unused. It creates an
index with exactly those two members and annotations binding the Ploinky and
image-definition commits, run/attempt, and native digests. It verifies the index
by immutable digest and confirms the candidate tag still has identical bytes.
The index, candidate proof, and both complete native evidence sets are retained
for 30 days. Failed native checks also retain their available diagnostics.

A separate promotion job runs only for `promote_stable=true` after the merge job
succeeds. It moves both release aliases to that already-verified immutable index
and confirms both resolve to the same digest. The candidate tag is retained,
and workflow concurrency prevents competing promotions. A candidate-only run
never writes either release alias.

### Promoting an accepted candidate

`promote_stable=true` can only promote the digest the same run just built. To
move `latest` and `runtime` to a candidate that was built earlier and has since
passed browser acceptance, dispatch `promote-ploinky-box-candidate.yml`. It has
no build step: it never builds, pulls an image, or pushes a new one, it only
re-verifies the candidate and re-tags its immutable index. It joins the
`publish-ploinky-box-image` concurrency group (`cancel-in-progress: false`), so
it cannot overlap a publication. Coordinate the release window yourself as well:
a queued unrelated promotion or a manual registry write is not prevented.

| Input | Meaning |
| --- | --- |
| `candidate_run_id`, `candidate_run_attempt` | The successful run and attempt of `publish-ploinky-box-image.yml` that built the candidate |
| `candidate_digest` | The full immutable index digest, `sha256:` plus 64 hex characters; a tag is rejected |
| `source_sha`, `image_definitions_sha` | The Ploinky commit and the image-definition commit of that run |
| `acceptance_receipt_json` | The bounded receipt below |

The workflow runs only when dispatched from `refs/heads/main`; the first step of
both jobs refuses any other ref. No Buildx builder is set up (`imagetools` talks
to the registry directly, so nothing is built or pulled). GitHub keeps one
pending run per concurrency group and cancels an older pending run when a newer
one queues: that fails safe, nothing is written, and the operator re-dispatches.

The `verify` job holds no registry credential and finishes before the `promote`
job, which alone logs in. In order, `verify`:

1. Validates every input, then pins the run through `gh api
   repos/AssistOS-AI/container-image-builds/actions/runs/<id>/attempts/<n>`: the
   fixed repository (also as the head repository), the path
   `.github/workflows/publish-ploinky-box-image.yml`, a `workflow_dispatch` event,
   `completed` with `success`, the exact attempt, and `head_sha ==
   image_definitions_sha`.
2. Downloads, from that run only, the candidate artifact
   `ploinky-box-candidate-<run>-<attempt>`, both native evidence sets, and the
   frozen `ploinky-box-library-inputs-<run>-<attempt>` artifact. Each must exist
   once, unexpired, and belong to that run and head commit.
3. Checks out `image_definitions_sha` and `source_sha` without persisted
   credentials, and requires both clean and at those commits.
4. Rebuilds the publication context from the candidate's own run ID, attempt,
   Ploinky commit, image-definition commit and frozen library selections. The
   promotion run's own `GITHUB_SHA` and run ID are never used for it; they are
   recorded separately as the promotion identity. The verifier is loaded from the
   `image_definitions_sha` checkout, because its bytes are part of every saved
   proof.
5. Fetches the raw index by digest and requires `sha256(raw index) ==
   candidate_digest`, equality with the candidate artifact's index copies, and
   byte equality of the downloaded native sets with the candidate artifact's
   copy. It then runs the candidate's own `publicationContext`,
   `verifyNativeProofs` and `verifyCandidate` in a child process: that is
   candidate code, so it gets a fresh environment (no `GITHUB_OUTPUT`,
   `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`, token or secret) and
   cannot patch the verifying process. Before the child starts, the parent reads
   the saved `candidate-proof.json`, both `native-proof.json` files, `digest.txt`
   and the raw evidence into memory and checks them: each `native-proof.json`
   must hash to `nativeProofSha256`, each raw file to its recorded hash, and the
   normalized `Id` of each raw `image-inspect.json` must equal that proof's
   `configDigest`. The child runs against a private temporary copy of the native
   evidence, which is deleted afterwards, and the parent compares its output only
   with that in-memory snapshot, so nothing the child writes to disk is read back
   as trusted. That covers the index
   annotations, exactly the amd64 and arm64 members, the frozen library commits,
   and the confined smoke and negative self-test.
6. Validates the acceptance receipt against the same pins.

Only then does `promote` record the previous `latest` and `runtime` indexes, log
in, and run the existing `docker buildx imagetools create --tag
docker.io/assistos/ploinky-box:latest --tag docker.io/assistos/ploinky-box:runtime
docker.io/assistos/ploinky-box@<digest>`. It then fetches both aliases' raw
indexes and requires their byte hashes to equal the accepted digest. The
confirmation runs even after a failed write; a mismatch fails the release and the
job summary lists the exact current aliases. The record (previous aliases,
accepted digest, candidate and promotion run IDs, commits, confirmation) is
uploaded as `ploinky-box-promotion-record-<run>-<attempt>`. The two-tag write is
not atomic, so a partial write is reported, and dispatching the same inputs
again completes it (`mode=complete-partial`); when both aliases already resolve
to the digest nothing is written (`mode=current`) and the confirmation still
runs. The candidate tag and artifacts are kept.

#### Acceptance receipt

The receipt is bounded (16 KiB), data-only JSON of schema
`ploinky.box.acceptance-receipt/v1`, in canonical form (keys sorted at every
level, no whitespace); the workflow rejects any other text, so the stored
evidence is exactly the validated value. It binds the candidate digest, the
Ploinky, Explorer, AgentLib and AchillesCLI revisions with an explicit
`mcp_sdk_commit`, the generation, the per-architecture engine image ID, and one
entry per acceptance phase. All five phases are required, in this order:

| Phase id | Spec | Counts |
| --- | --- | --- |
| `copilot-folder-launch` | `05` | release gate: exactly 1 passed |
| `copilot-live-skills` | `06` | prerequisite: every selected test passed, at least 1 |
| `optional-agents` | `03` (Marketplace) | prerequisite: every selected test passed, at least 1 |
| `onlyoffice-confidential` | `50` | release gate: exactly 1 passed |
| `webmeet-room-chat` | `30` | release gate: exactly 1 passed |

Every entry records its spec, the exact titles of the selected tests (`tests`,
which must include the pinned title), the `passed`, `failed`, `skipped`,
`retried` and `flaky` counts (the last four are always 0), and the SHA-256 of its
report. The five phases are the mandatory sequence; the receipt can record its
order but not prove it. `build` writes the canonical text with no trailing
newline, and neither `validate` nor the workflow accepts one, so the output file
is exactly the text to dispatch. Produce it from the saved Playwright JSON reports, the
release manifest and the engine's `image inspect` output of the Box image the
acceptance fixture ran. Both the Docker shape (`Id` as `sha256:<hex>`) and the
Podman shape (a bare 64-hex `Id`, next to `Digest`, `RepoDigests` and `History`)
are accepted, and the ID is normalized to `sha256:<hex>` the way Ploinky's
`normalizeImageId` does before it is compared with the release manifest's Box
digest and stored:

```sh
node images/ploinky-box/acceptance-receipt.mjs build \
  --candidate-digest "$PLAN_ACCEPTED_INDEX_DIGEST" \
  --release-manifest "$EVIDENCE/release_manifest.json" \
  --image-inspect "$EVIDENCE/box-image-inspect.json" \
  --mcp-sdk-commit "$PLAN_MCP_SDK_SHA" --generation "$GENERATION" \
  --report copilot-folder-launch="$EVIDENCE/05/results.json" \
  --report copilot-live-skills="$EVIDENCE/06/results.json" \
  --report optional-agents="$EVIDENCE/03/results.json" \
  --report onlyoffice-confidential="$EVIDENCE/50/results.json" \
  --report webmeet-room-chat="$EVIDENCE/30/results.json" > "$EVIDENCE/acceptance-receipt.json"
```

The workflow checks that the receipt names the promoted digest, that its Ploinky
revision is `source_sha`, that its AgentLib and MCP SDK commits are the frozen
library-input commits, and that each engine image ID equals the verified
`configDigest` of that architecture's image. It cannot prove that the receipt
was built from real reports or that a browser run took place: the Explorer and
AchillesCLI commits are checked only for format. The dispatch is the authorized
operator's release attestation, so retain and inspect the raw reports named by
the receipt (their SHA-256 digests are in it) before dispatching. Pass the
receipt as a structured argument, for example `-f
acceptance_receipt_json="$(cat "$EVIDENCE/acceptance-receipt.json")"`; the
workflow reads every input through `env:`, never by interpolation into a script.

## Secrets

Each publishing workflow logs in to Docker Hub as `assistos` and requires:

```sh
gh secret set DOCKERHUB_TOKEN --repo AssistOS-AI/container-image-builds
```

If the source repositories are private to the Actions runner, also configure a
read-only token that can check them out:

```sh
gh secret set SOURCE_REPO_TOKEN --repo AssistOS-AI/container-image-builds
```

Do not store Docker Hub token values in repository files.

## Manual Publishing

```sh
gh workflow run publish-ploinky-node-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f promote_stable=false

gh workflow run publish-onlyoffice-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f onlyoffice_version=9.3.1 \
  -f image_tag=9.3.1

gh workflow run publish-llm-runtime-cpu-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f llama_cpp_ref=b6412 \
  -f image_tag=cpu-arm64-smoke \
  -f platforms=linux/arm64

gh workflow run publish-umami-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f promote_stable=false

gh workflow run publish-bwrap-runner.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../basic rev-parse HEAD)" \
  -f copilot_agents_ref="$(git -C ../copilot-agents rev-parse HEAD)" \
  -f achilles_cli_ref="$(git -C ../AchillesCLI rev-parse HEAD)" \
  -f promote_stable=false

# Use an AssistOSExplorer checkout at the current origin/main tip.
# LIVEKIT_EGRESS_IMAGE must be the verified patched Egress multiarchitecture
# index reference: docker.io/assistos/livekit-egress@sha256:<64 lowercase hex>.
gh workflow run publish-livekit-server-agent.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../AssistOSExplorer rev-parse HEAD)" \
  -f egress_image="${LIVEKIT_EGRESS_IMAGE:?Set the verified patched Egress index reference}" \
  -f image_tag=webmeet-infra

gh workflow run publish-soul-gateway-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=main \
  -f image_tag=node24-sqlite

gh workflow run publish-ploinky-box-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../ploinky rev-parse HEAD)" \
  -f promote_stable=false
# Optional exact library commits: -f agentlib_commit=<40-hex> -f mcp_sdk_commit=<40-hex>
```

`latest` and its `runtime` compatibility alias are intentionally mutable, but an
already-created Ploinky Box stays on its inspected image ID. The supervisor
consults the selected channel only when creating a missing Box or performing a
validated replacement. An incompatible image or unrecognized configuration
drift is rejected before mutation and requires an explicit destroy followed by
recreate. Moving the release channel to a different verified manifest digest is
a separately authorized registry release action, never a supervisor
transaction; the channel must not point to an incompatible image. Reuse,
status, stop, and destroy do not pull the channel.

The Node, Umami, Bubblewrap, and Ploinky Box publish workflows are manually dispatched and default
to candidate publication without stable promotion. A Ploinky Box candidate that
passed acceptance is promoted with `promote-ploinky-box-candidate.yml` (see
[Promoting an accepted candidate](#promoting-an-accepted-candidate)). Other workflows keep their
own documented triggers and source inputs.

## QA host Git bootstrap

`build-qa-git-toolchain.yml` builds a native `linux/amd64` Git 2.55.0
installation from the checksum-pinned official release in
`images/qa-git/Dockerfile`. Its Ubuntu 24.04 builder selects Ubuntu's OpenSSL
libcurl development package; the resulting HTTPS helper uses the host's
ordinary `libcurl.so.4`, without shipping or replacing TLS libraries.

The complete installation includes Git's HTTPS helpers, scripts and templates.
`RUNTIME_PREFIX` permits relocation. A clean Ubuntu 24.04 validation stage moves
the installation to a different prefix, checks helper linkage and templates,
and runs the shared default/HTTP2 Git and npm download probes before the
workflow seals its archive and provenance. The artifact is a bootstrap toolchain,
not an agent image or a host package installation.

A QA operator installs the verified archive into a versioned QA-owned directory
outside the disposable workspace and prepends its `bin` directory only to the
QA bootstrap/deployment process. Clear inherited `GIT_EXEC_PATH` and transport
settings for acceptance tests, and verify helper resolution and library linkage
on the target. Do not modify system Git, production PATH, host TLS libraries, or
system/global Git configuration. Ubuntu maintains the dynamically linked TLS
packages; updating this separate Git release requires a reviewed source pin and
a new passing artifact.
