import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const contractSuffix = 'vulkan_contract=1\nvulkan_llama_cpp=b11159\nvulkan_llama_cpp_server=/opt/llama.cpp-vulkan/llama-server\nvulkan_mesa=25.3.6+libkrun.3\nvulkan_icd_radv=/opt/local-llm/vulkan/icd.d/radeon_icd.json\nvulkan_icd_venus=/opt/local-llm/vulkan/icd.d/virtio_icd.json\nvulkaninfo=/usr/bin/vulkaninfo\n';

function manifest(text) {
    const entries = new Map();
    for (const line of text.trimEnd().split('\n')) {
        const fields = line.split(' ');
        assert.equal(fields.length, 6, `invalid manifest: ${line}`);
        assert.ok(!entries.has(fields[0]), `duplicate manifest path: ${fields[0]}`);
        entries.set(fields[0], fields);
    }
    return entries;
}

const transient = (p) => ['/.dockerenv', '/run/.containerenv', '/etc/hostname', '/etc/hosts', '/etc/resolv.conf', '/etc/mtab'].includes(p)
    || /^\/(dev|proc|sys)(\/|$)/.test(p);
const mutable = (p) => ['/opt/local-llm/source.contract', '/etc/ld.so.cache', '/var/cache/ldconfig/aux-cache', '/var/lib/dpkg/status', '/var/lib/dpkg/status-old', '/var/log/dpkg.log', '/var/lib/apt/extended_states'].includes(p)
    || /^\/var\/cache\/debconf\/[^/]+\.dat(?:-old)?$/.test(p)
    || /^\/var\/lib\/dpkg\/triggers\/[^/]+$/.test(p)
    || /^\/var\/log\/apt\/[^/]+$/.test(p);

// The pinned parents contain these OpenGL symlinks. Acceptance preserves
// them byte-for-byte; it still refuses added swrast paths and software Vulkan.
const inheritedOpenGl = new Set([
    '/usr/lib/aarch64-linux-gnu/dri/kms_swrast_dri.so',
    '/usr/lib/aarch64-linux-gnu/dri/swrast_dri.so',
    '/usr/lib/x86_64-linux-gnu/dri/kms_swrast_dri.so',
    '/usr/lib/x86_64-linux-gnu/dri/swrast_dri.so',
]);

export function compareManifests(parentText, childText, { selfTest = false } = {}) {
    const parent = manifest(parentText), child = manifest(childText), excluded = [];
    for (const [p, fields] of parent) {
        const found = child.get(p);
        assert.ok(found, `parent path deleted: ${p}`);
        if (transient(p)) {
            assert.equal(found[1], fields[1], `excluded path type changed: ${p}`);
            excluded.push(p);
        } else if (selfTest || !mutable(p)) {
            assert.deepEqual(found, fields, `parent path changed: ${p}`);
        }
    }
    for (const p of child.keys()) {
        if (selfTest && !transient(p)) assert.ok(parent.has(p), `unexpected parent-repeat path: ${p}`);
        if (!selfTest) {
            assert.doesNotMatch(p, /libvulkan_lvp|lvp_icd|libvulkan_intel/, `forbidden Vulkan driver: ${p}`);
            if (p.includes('swrast')) {
                assert.ok(inheritedOpenGl.has(p) && parent.has(p), `forbidden added swrast path: ${p}`);
                assert.equal(child.get(p)[1], 'symlink', `inherited OpenGL entry type changed: ${p}`);
                assert.equal(child.get(p)[5], 'libdril_dri.so', `inherited OpenGL target changed: ${p}`);
            }
        }
        if (transient(p) && !excluded.includes(p)) excluded.push(p);
    }
    return excluded.sort();
}

export function compareInspect(parent, child, arch, revision) {
    assert.equal(parent.Architecture, arch);
    assert.equal(child.Architecture, arch);
    assert.equal(child.Config.User, '1000:1000');
    for (const key of ['User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Env']) {
        assert.deepEqual(child.Config[key], parent.Config[key], `config changed: ${key}`);
    }
    const parentLabels = { ...parent.Config.Labels }, childLabels = { ...child.Config.Labels };
    assert.equal(childLabels['org.opencontainers.image.revision'], revision);
    delete parentLabels['org.opencontainers.image.revision'];
    delete childLabels['org.opencontainers.image.revision'];
    assert.deepEqual(childLabels, parentLabels, 'parent labels changed');
    const layers = parent.RootFS.Layers, added = child.RootFS.Layers.slice(layers.length);
    assert.ok(added.length >= 1 && added.length <= 6, 'expected 1–6 added layers');
    assert.deepEqual(child.RootFS.Layers.slice(0, layers.length), layers, 'parent layers are not a prefix');
    return { parent: layers, child: child.RootFS.Layers, added };
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

export function verifyEvidence(dir, arch, revision) {
    const parent = readJson(path.join(dir, 'parent-inspect.json'))[0];
    const child = readJson(path.join(dir, 'child-inspect.json'))[0];
    const layers = compareInspect(parent, child, arch, revision);
    const excluded = compareManifests(fs.readFileSync(path.join(dir, 'parent.manifest'), 'utf8'), fs.readFileSync(path.join(dir, 'child.manifest'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'excluded-seen.txt'), excluded.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'layers.json'), JSON.stringify(layers, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    verifyEvidence(process.argv[2], process.argv[3], process.argv[4]);
}
