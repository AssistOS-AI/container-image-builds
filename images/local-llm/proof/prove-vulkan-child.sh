#!/usr/bin/env bash
set -euo pipefail
ENGINE=${ENGINE:-docker}
: "${EVIDENCE:?Set EVIDENCE to a fresh evidence directory}"
here=$(cd "$(dirname "$0")" && pwd)
command -v "$ENGINE" >/dev/null
command -v node >/dev/null
python3 -I -c 'import tarfile, hashlib' >/dev/null
mkdir -p "$EVIDENCE"
test ! -e "$EVIDENCE/proof-ok.txt"
active=
cleanup() { if [ -n "$active" ]; then "$ENGINE" rm "$active" >/dev/null; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
extract() {
    active=$("$ENGINE" create --pull=never --name "vulkan-proof-$$-$2" "$1" /bin/true)
    test -n "$active"
    "$ENGINE" export "$active" | python3 -I "$here/tar-manifest.py" > "$EVIDENCE/$2.manifest"
    "$ENGINE" rm "$active" >/dev/null
    active=
}
if [ "${1:-}" = --self-test ]; then
    test "$#" = 2
    extract "$2" parent
    extract "$2" parent-repeat
    node --input-type=module - "$here" "$EVIDENCE" <<'JS'
import fs from 'node:fs';
const {compareManifests}=await import(`${process.argv[2]}/verify-vulkan-child.mjs`);
const read=n=>fs.readFileSync(`${process.argv[3]}/${n}.manifest`,'utf8');
fs.writeFileSync(`${process.argv[3]}/excluded-seen.txt`,compareManifests(read('parent'),read('parent-repeat'),{selfTest:true}).join('\n')+'\n');
JS
    printf 'ok\n' > "$EVIDENCE/self-test-ok.txt"
    exit 0
fi
test "$#" = 3
child=$1; parent=$2; arch=$3
: "${EXPECTED_REVISION:?Set EXPECTED_REVISION}"
case "$arch" in amd64|arm64) ;; *) exit 1;; esac
"$ENGINE" image inspect "$parent" > "$EVIDENCE/parent-inspect.json"
"$ENGINE" image inspect "$child" > "$EVIDENCE/child-inspect.json"
extract "$parent" parent
extract "$child" child
node "$here/verify-vulkan-child.mjs" "$EVIDENCE" "$arch" "$EXPECTED_REVISION"
run() { "$ENGINE" run --rm --pull=never --network=none --cap-drop=ALL --security-opt=no-new-privileges "$@"; }
run "$parent" cat /opt/local-llm/source.contract > "$EVIDENCE/parent.contract"
run "$child" cat /opt/local-llm/source.contract > "$EVIDENCE/child.contract"
node --input-type=module - "$here" "$EVIDENCE" <<'JS'
import fs from 'node:fs'; import assert from 'node:assert/strict';
const {contractSuffix}=await import(`${process.argv[2]}/verify-vulkan-child.mjs`);
const p=process.argv[3];assert.equal(fs.readFileSync(`${p}/child.contract`,'utf8'),fs.readFileSync(`${p}/parent.contract`,'utf8')+contractSuffix);
JS
# Reuse the canonical parent assertions without editing either parent job's proof body.
node --input-type=module - "$here/../../.." "$arch" "$EVIDENCE" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const workflow=fs.readFileSync(`${process.argv[2]}/.github/workflows/publish-local-llm-image.yml`,'utf8');
const job=workflow.split(`\n  ${process.argv[3]}:\n`)[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
const runtime=job.match(/run "\$image" sh -c '(set -eu;[^\n]+)'/);
const closure=job.match(/run "\$image" sh -c '(\n[\s\S]*?)' \| tee/);
assert.ok(runtime && closure,'canonical parent runtime assertions missing');
fs.writeFileSync(`${process.argv[4]}/parent-runtime.sh`,runtime[1]);
fs.writeFileSync(`${process.argv[4]}/parent-closure.sh`,closure[1]);
JS
run "$child" sh -c "$(cat "$EVIDENCE/parent-runtime.sh")" > "$EVIDENCE/runtime.txt"
test "$(sed -n 1p "$EVIDENCE/runtime.txt")" = 1000
grep -q 'build 11159,' "$EVIDENCE/runtime.txt"
grep -q '^/usr/local/nvidia/bin:' "$EVIDENCE/runtime.txt"
if [ "$arch" = amd64 ]; then grep -q 'version is 0.34.4' "$EVIDENCE/runtime.txt"; fi
if [ "$arch" = arm64 ]; then test "$(tail -n 1 "$EVIDENCE/runtime.txt")" = /usr/local/nvidia/lib64; fi
run "$child" sh -c "$(cat "$EVIDENCE/parent-closure.sh")" > "$EVIDENCE/runtime-contract.txt"
run "$child" cat /opt/local-llm/runners.lock.json > "$EVIDENCE/runners.lock.json"
lock="$here/../runners.lock.json"
if [ "$arch" = arm64 ]; then lock="$here/../runners.lock.arm64.json"; fi
cmp "$lock" "$EVIDENCE/runners.lock.json"
for scan in weights lmstudio; do
    if [ "$scan" = weights ]; then
        query='find / -xdev -type f \( -name "*.gguf" -o -name "*.safetensors" -o -path "*/blobs/sha256-*" \)'
    else
        query='find / -xdev \( -iname "*llmster*" -o -iname "*liblmstudio*" -o -iname ".lmstudio*" -o -iname "*lm-studio*" \)'
    fi
    run --user 0 --cap-add=DAC_READ_SEARCH "$child" sh -c "$query" > "$EVIDENCE/$scan.txt" 2> "$EVIDENCE/$scan-errors.txt"
    test ! -s "$EVIDENCE/$scan-errors.txt"
    test ! -s "$EVIDENCE/$scan.txt"
done
cuda='set -eu; for f in /opt/llama.cpp/llama-server /opt/llama.cpp/*.so*; do printf "%s\n" "$f"; LD_LIBRARY_PATH=/usr/local/nvidia/lib64 ldd "$f"; done; if [ -d /opt/ik_llama.cpp ]; then for f in /opt/ik_llama.cpp/llama-server /opt/ik_llama.cpp/*.so /opt/ollama/lib/ollama/cuda_v12/libggml-cuda.so /opt/ollama/lib/ollama/cuda_v13/libggml-cuda.so; do printf "%s\n" "$f"; LD_LIBRARY_PATH=/usr/local/nvidia/lib64 ldd "$f"; done; fi'
for image in parent child; do
    ref=$parent; if [ "$image" = child ]; then ref=$child; fi
    run "$ref" sh -c "$cuda" | sed 's/ (0x[0-9a-f]*)//g' > "$EVIDENCE/$image-cuda-ldd.txt"
done
cmp "$EVIDENCE/parent-cuda-ldd.txt" "$EVIDENCE/child-cuda-ldd.txt"
icds=/opt/local-llm/vulkan/icd.d/radeon_icd.json:/opt/local-llm/vulkan/icd.d/virtio_icd.json
run -e "VK_DRIVER_FILES=$icds" -e 'VK_LOADER_LAYERS_DISABLE=~all~' "$child" /opt/llama.cpp-vulkan/llama-server --version > "$EVIDENCE/vulkan-version.txt" 2>&1
grep -q 'build 11159,' "$EVIDENCE/vulkan-version.txt"
run -e "VK_DRIVER_FILES=$icds" -e 'VK_LOADER_LAYERS_DISABLE=~all~' "$child" /opt/llama.cpp-vulkan/llama-server --list-devices > "$EVIDENCE/list-devices.txt" 2> "$EVIDENCE/list-devices-stderr.txt"
printf 'Available devices:\n  (none)\n' > "$EVIDENCE/list-devices-expected.txt"
cmp "$EVIDENCE/list-devices-expected.txt" "$EVIDENCE/list-devices.txt"
run "$child" node -e 'const fs=require("node:fs"),p="/opt/local-llm/vulkan";for(const [id,lib] of [["radeon","radeon"],["virtio","virtio"]]){const d=JSON.parse(fs.readFileSync(`${p}/icd.d/${id}_icd.json`));if(d.ICD.library_path!==`${p}/lib/libvulkan_${lib}.so`||!fs.statSync(d.ICD.library_path).isFile())process.exit(1)}'
run "$child" sh -c 'set -eu; test ! -e /usr/share/vulkan/icd.d || test -z "$(ls -A /usr/share/vulkan/icd.d)"; for f in /opt/local-llm/vulkan/lib/libvulkan_*.so /usr/bin/vulkaninfo /opt/llama.cpp-vulkan/llama-server /opt/llama.cpp-vulkan/*.so*; do test -f "$f"; ldd "$f"; done; if dpkg-query -W -f "\${Status}" mesa-vulkan-drivers 2>/dev/null | grep -q "install ok installed"; then exit 1; fi' > "$EVIDENCE/vulkan-ldd.txt"
if grep -q 'not found' "$EVIDENCE/vulkan-ldd.txt"; then exit 1; fi
run "$child" dpkg-query -W -f '${Package} ${Version}\n' libvulkan1 vulkan-tools > "$EVIDENCE/packages.txt"
node --input-type=module - "$here/.." "$arch" "$EVIDENCE" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const lock=JSON.parse(fs.readFileSync(`${process.argv[2]}/sources.lock${process.argv[3]==='arm64'?'.arm64':''}.json`));
assert.equal(fs.readFileSync(`${process.argv[4]}/packages.txt`,'utf8'),Object.entries(lock.vulkan.runtimePackages).map(([k,v])=>`${k} ${v}\n`).sort().join(''));
JS
# CI binds compressed registry layers and config to the exact pushed digest. Local proof records image ID.
if [ "$ENGINE" = docker ]; then
    docker buildx imagetools inspect --raw "$child" > "$EVIDENCE/child-registry.json"
    docker buildx imagetools inspect --raw "$parent" > "$EVIDENCE/parent-registry.json"
    node --input-type=module - "$EVIDENCE" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const p=process.argv[2],read=n=>JSON.parse(fs.readFileSync(`${p}/${n}-registry.json`));
const a=read('parent'),b=read('child');assert.deepEqual(b.layers.slice(0,a.layers.length).map(l=>l.digest),a.layers.map(l=>l.digest));
fs.writeFileSync(`${p}/config-digest.txt`,b.config.digest+'\n');
fs.writeFileSync(`${p}/added-compressed-size.txt`,String(b.layers.slice(a.layers.length).reduce((n,l)=>n+l.size,0))+'\n');
JS
else
    node -e 'const fs=require("node:fs"),p=process.argv[1],d=JSON.parse(fs.readFileSync(p+"/child-inspect.json"))[0];fs.writeFileSync(p+"/config-digest.txt",(d.Id.startsWith("sha256:")?d.Id:"sha256:"+d.Id)+"\n")' "$EVIDENCE"
    printf 'pending: local export does not measure registry compression\n' > "$EVIDENCE/added-compressed-size.txt"
fi
printf '%s\n' "${child##*@}" > "$EVIDENCE/digest.txt"
printf '%s\n' "${parent##*@}" > "$EVIDENCE/parent.txt"
printf '%s\n' "$EXPECTED_REVISION" > "$EVIDENCE/revision.txt"
printf 'ok\n' > "$EVIDENCE/proof-ok.txt"
