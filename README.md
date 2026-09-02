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
| `assistos/default-local-llm:cpu-qwen25-coder-1.5b` | `AssistOS-AI/proxies` | `default-local-llm` | `images/default-local-llm/Dockerfile` | `publish-default-local-llm-image.yml` |
| `assistos/search-agent:searxng-browser` | `AssistOS-AI/proxies` | `searchAgent` | `images/search-agent/Dockerfile` | `publish-search-agent-image.yml` |
| `assistos/roboteam-agent:runtime` | this repo | `images/roboteam-agent` | `images/roboteam-agent/Dockerfile` | `publish-roboteam-agent-image.yml` |
| `assistos/roboteam-workstation:cul-0.5.0-v1` | this repo | `images/roboteam-agent` | `images/roboteam-agent/Dockerfile.workstation` | `publish-roboteam-agent-image.yml` |
| `assistos/bwrap-runner:node24-python-trixie` | `AssistOS-AI/basic` | `bwrap-runner` | `images/bwrap-runner/Dockerfile` | `publish-bwrap-runner.yml` |
| `assistos/livekit-server-agent:webmeet-infra` | `AssistOS-AI/webmeetInfra` | `liveKitServerAgent` | `images/livekit-server-agent/Dockerfile` | `publish-livekit-server-agent.yml` |
| `assistos/soul-gateway:node24-sqlite` | `AssistOS-AI/proxies` | `soul-gateway` | `images/soul-gateway/Dockerfile` | `publish-soul-gateway-image.yml` |
| `assistos/ploinky-box:latest` (`runtime` compatibility alias) | this repo plus immutable `AssistOS-AI/ploinky` and lock-selected `AssistOS-AI/MCPSDK` commits | repo root; rootless nested-Podman appliance with the canonical Ploinky entrypoint, bundled MCP SDK, and integrated cloudflared | `images/ploinky-box/Dockerfile` | `publish-ploinky-box-image.yml` |

The `bwrap-runner` workflow checks out exact full-SHA `basic`, `copilot-agents`,
and `AchillesCLI` inputs under `sources/`; the latter two supply the Open
Interpreter and GPTResearcher consumer gates. Those two SHAs are explicitly
prepublication consumer-code inputs: they contain the ABI/disposition adapters
while retaining the existing privileged declarations and mutable image
references. The workflow neither requires nor creates the later digest-pin and
privilege-removal commits, so publication remains the input to those consumer
changes rather than depending on them. The `livekit-server-agent`
workflow also checks out its source repository under `sources/`. The
`ploinky-box` workflow checks out Ploinky at an exact commit, resolves the MCP
SDK commit from Ploinky's dependency lock, and checks out that exact source
without persisted credentials. The image consumes the canonical Box
entrypoint, sealed MCP SDK bundle contract, and exact WebTTY native package,
lockfile, and self-contained probe; Router and application source remain on the
read-only runtime mount. Native architecture images are published by immutable
digest.

The LiveKit workflow accepts only the exact 40-character commit SHA at the
current tip of `webmeetInfra/ploinky-proxy`. It builds and smoke-tests the local
architecture before authenticating and publishing the multiarchitecture image.
Its three base images are pinned by manifest-list digest, and Ubuntu package
resolution is pinned to a dated repository snapshot with exact direct-package
versions. The pinned `libc-bin` package and both build-time and workflow smoke
gates guarantee that the startup script's `getent` dependency is present.

The LiveKit workflow keeps its stable release tag and
also exposes the pushed multiarchitecture manifest digest as the `publish` job's
`digest` output. Each workflow validates that build output as an exact sha256
digest and writes the resulting `docker.io/assistos/...@sha256:...` reference
to both the log and GitHub job summary. Publishing and pinning consumer
manifests remain separate authorized operations.

## Umami agent supply chain

The Umami Agent build has no source-image, Bun-version, or MCP-revision input.
`images/umami-agent/sources.lock.json` records the reviewed inputs, and focused
tests require the Dockerfile, embedded image metadata, and publication workflow
to agree with that lock.

| Input | Immutable selection | Architecture contract |
| --- | --- | --- |
| Umami | `docker.umami.is/umami-software/umami:3.2.0@sha256:8edfe4beaef13f9d1300619fa264ef250a3688df9cc54d24ca830ca31cb475ec` | The index resolves to `sha256:afbd42695964762c2accf8ed0d863211d764c3937dbba0bf808ba5e33afae763` for `linux/amd64` and `sha256:41c5df65ee777b762411c105f9b040e33708ef8640a19a2d2b9abf3284ee3f37` for `linux/arm64`. |
| Bun | Release `1.3.14` | The build selects the exact x64-musl or aarch64-musl archive and verifies its recorded SHA-256 before extraction. |
| `MadsNyl/umami-mcp` | Commit `3ab73beda2db0ebffb0b07439b218ef562107520` | The build fetches that object directly, checks out detached `FETCH_HEAD`, verifies the resulting commit, and verifies the committed `bun.lock` digest before frozen installation. |

The direct Alpine packages are version-pinned. The built image carries OCI
labels for the base index, Bun version, MCP commit, and MCP lock digest, plus a
read-only copy of the full source lock. The workflow smoke-checks those values,
publishes an amd64/arm64 index with provenance and an SBOM, verifies that both
platform manifests exist, and reports the resulting immutable image digest.
Publishing does not update the consumer manifest; pinning that new output is a
separate reviewed operation.

## SearchAgent runtime

`docker.io/assistos/search-agent:searxng-browser` layers Chromium, a pinned
SearXNG source revision, its Python environment, and the pinned Puppeteer
runtime onto the standard Ploinky Node image. System packages and `/opt`
content are created only while building the immutable image as root. The
published runtime restores UID/GID `1000:1000`, so enabling SearchAgent never
requires package-manager or system-directory privileges.

## RoboTeam nested Podman runtime

`docker.io/assistos/roboteam-agent:runtime` is the outer runtime for RoboTeam. It uses
the exact Podman 6 upstream and Ploinky Node multiarchitecture bases recorded in
`images/roboteam-agent/sources.lock.json`, copies the Node runtime into the
Podman base, and provides Podman, fuse-overlayfs, pasta, curl, Git, and Bash.
The outer image does not contain a GUI. RoboTeam starts the separately published
`docker.io/assistos/roboteam-workstation:cul-0.5.0-v1` as its inner OCI
workstation.

The workstation definition is `images/roboteam-agent/Dockerfile.workstation`.
It derives from the digest-pinned LinuxServer Ubuntu XFCE Webtop base and adds
`computer-use-linux` 0.5.0 after verifying the architecture-specific release
checksum. The image also installs the X11, AT-SPI, window-control, and screenshot
dependencies required by computer use. Its fixed stdio launcher reads the live
XFCE display and D-Bus environment, disables the optional shell tool, and starts
the MCP server without opening a network listener. A second launcher focuses or
starts Chromium with renderer accessibility enabled. The image intentionally
contains no LLM agent or task controller.

The root-owned read-only contract is
`/opt/roboteam-runtime/contract-v3`, containing `roboteam-runtime-v3` followed
by one newline. Inner storage is configured under
`/data/podman/storage` with fuse-overlayfs and `ignore_chown_errors`, matching
the nested user-namespace constraints. SUID namespace helpers are removed.

The `nested` smoke mode runs a real inner Alpine container through `pasta` with
private IPC and 1 GiB shared memory. It is intended for a Ploinky Box or another
runtime that supplies `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, and `/dev/net/tun`;
GitHub-hosted Docker does not provide the required nested mount behavior.

Publication runs source checks, a capability-free outer contract smoke, and a
workstation tool smoke on the runner architecture. It then uses Buildx and QEMU
to publish amd64 and arm64 directly as the operator-managed `runtime` and
`cul-0.5.0-v1` tags. The workflow does not attempt the nested smoke, use
privileged mode, or mount a host engine socket.

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
for the outer appliance. Every publication also moves `runtime` to the same
manifest digest for compatibility with older Ploinky installations. The image
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
canonical `ploinky-box/entrypoint/ploinky-box-entrypoint`, MCP SDK bundle
contract and dependency lock, and the three exact native-package inputs
described below. It does not retain Router or application source, or a separate
image-repository entrypoint implementation.

The MCP SDK is packaged at `/usr/local/lib/ploinky/mcp-sdk`. Its builder input
must be the exact commit selected by Ploinky's lock, clean, dependency-free, and
free of symlinks. The builder strips `.git`, records a content fingerprint, and
the final image re-verifies the sealed tree as the unprivileged runtime user.
Box startup performs no MCP SDK Git or npm operation: it transactionally copies
the verified image bundle into the workspace-backed dependency cache and
repairs a missing, stale, or modified cache copy from those local bytes.

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
| Environment | `USER=podman`, `HOME=/home/podman`, `PLOINKY_WORKSPACE_ROOT=/workspace`, `PLOINKY_DISABLE_HOST_SANDBOX=1`, `container=oci`, `_CONTAINERS_USERNS_CONFIGURED=`, `BUILDAH_ISOLATION=chroot` |
| `PATH` | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Working directory | `/workspace` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | Absent |
| Declared image volumes | Absent |

The host workspace, reusable image content, and pinned dependencies outlive one
outer Box. The supervisor mounts the host workspace at `/workspace` and
bind-mounts two workspace-backed cache directories: `.ploinky/box/dependencies` at
`/opt/ploinky/node_modules` and `.ploinky/box/images` at
`/home/podman/.local/share/ploinky-images`. The workspace and both cache binds
survive stop, destroy, replacement, and recreation.

Everything else in the inner Podman store is disposable and is discarded with
the outer Box:

| Path | Lifetime |
| --- | --- |
| `/home/podman/.local/share/ploinky-images` | Workspace-backed host bind from `.ploinky/box/images`; downloaded image content only |
| `/opt/ploinky/node_modules` | Workspace-backed host bind from `.ploinky/box/dependencies`; pinned dependency cache |
| `/workspace` | Durable host bind; user and agent data |
| `/home/podman/.local/share/containers/storage` | Box writable layer; nested container records, writable layers, and inner named volumes |
| `/tmp/storage-run-1000` | Box tmpfs; reset on every startup |

The entrypoint renders `/home/podman/.config/containers/storage.conf` before the
first inner Podman call, pointing `imagestore` at the durable cache while
`graphroot` stays on the disposable writable layer with `transient_store`
enabled. Persistent agent data therefore belongs in `/workspace` binds, never in
inner Podman named volumes.

The first mutating call from a markerless workspace creates only an empty host
`.ploinky` identity anchor so descendants converge on the same Box. Status is
read-only. Stop uses a dedicated in-box helper and remains available when
dependency state is missing or corrupt. Outer candidate and replacement cleanup
includes anonymous volumes only.

First boot generates a mode-restricted workspace master key, validates the
direct AgentLib mount selected by the host, and materializes the lock-pinned MCP
SDK from the image bundle without network access. The key never crosses from
the host, is not printed, and is excluded from nested agents. It remains stable
with the host workspace because it is stored under `/workspace/.ploinky`.
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
The workflow verifies that immutable source checkout and its own image-definition
checkout are clean and at the requested revisions. It performs no behavioral,
unit, integration, E2E, Podman, or sibling-repository test execution.

Each native architecture job builds and pushes one image blob by immutable
digest, validates the digest format, and uploads only that digest as publication
evidence. The merge job requires exactly one amd64 digest and one arm64 digest,
proves the run-scoped
`runtime-candidate-GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT` tag is unused, and creates
a staging manifest from those two exact digests. It annotates and inspects
that manifest, requires exactly the supplied amd64 and arm64 members, records its
immutable digest, and moves both `latest` and the `runtime` compatibility alias
to that exact staging digest. Read-only confirmation proves both tags resolve to
the staged digest after promotion. The staging tag is retained as provenance,
workflow concurrency prevents competing promotion, and functional validation
remains separate from this publication-only workflow.

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

gh workflow run publish-default-local-llm-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=cpu-qwen25-coder-1.5b \
  -f model_repo=bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF \
  -f model_file=Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf

gh workflow run publish-umami-agent-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f image_tag=umami-stack

gh workflow run publish-bwrap-runner.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../basic rev-parse HEAD)" \
  -f copilot_agents_ref="$(git -C ../copilot-agents rev-parse HEAD)" \
  -f achilles_cli_ref="$(git -C ../AchillesCLI rev-parse HEAD)" \
  -f promote_stable=false

gh workflow run publish-livekit-server-agent.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../webmeetInfra rev-parse HEAD)" \
  -f image_tag=webmeet-infra

gh workflow run publish-soul-gateway-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref=main \
  -f image_tag=node24-sqlite

gh workflow run publish-ploinky-box-image.yml \
  --repo AssistOS-AI/container-image-builds \
  -f source_ref="$(git -C ../ploinky rev-parse HEAD)"
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

The Node and Bubblewrap publish workflows are manually dispatched and default
to candidate publication without stable promotion. Other workflows keep their
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
