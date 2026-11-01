import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Read ELF version requirements, never arbitrary strings or exported definitions.
export function requiredVersions(bytes) {
    if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46'
        || bytes[4] !== 2 || bytes[5] !== 1) throw new Error('expected little-endian ELF64');
    const range = (offset, size) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error('truncated ELF');
    };
    const u16 = (offset) => { range(offset, 2); return bytes.readUInt16LE(offset); };
    const u32 = (offset) => { range(offset, 4); return bytes.readUInt32LE(offset); };
    const u64 = (offset) => { range(offset, 8); return Number(bytes.readBigUInt64LE(offset)); };
    const sections = [];
    const start = u64(40), stride = u16(58), count = u16(60);
    if (stride < 64 || !count) throw new Error('ELF section headers required');
    range(start, stride * count);
    for (let i = 0; i < count; i++) {
        const at = start + i * stride;
        const section = { type: u32(at + 4), offset: u64(at + 24), size: u64(at + 32), link: u32(at + 40) };
        if (section.type !== 8) range(section.offset, section.size);
        sections.push(section);
    }
    const versions = new Set();
    for (const section of sections.filter((entry) => entry.type === 0x6ffffffe)) {
        const strings = sections[section.link];
        if (!strings) throw new Error('missing ELF version string table');
        let at = section.offset;
        const end = at + section.size;
        while (at < end) {
            if (at + 16 > end || u16(at) !== 1) throw new Error('invalid ELF version requirement');
            let aux = at + u32(at + 8);
            for (let i = 0; i < u16(at + 2); i++) {
                if (aux < at || aux + 16 > end) throw new Error('invalid ELF version auxiliary entry');
                const nameAt = strings.offset + u32(aux + 8);
                const nameEnd = bytes.indexOf(0, nameAt);
                if (nameAt < strings.offset || nameEnd < nameAt || nameEnd >= strings.offset + strings.size) throw new Error('invalid ELF version name');
                versions.add(bytes.toString('utf8', nameAt, nameEnd));
                const next = u32(aux + 12);
                if (i + 1 < u16(at + 2) && next < 16) throw new Error('invalid ELF auxiliary link');
                aux += next;
            }
            const next = u32(at + 12);
            if (!next) break;
            if (next < 16) throw new Error('invalid ELF version link');
            at += next;
            if (at >= end) throw new Error('invalid ELF version link');
        }
    }
    return [...versions].sort();
}

const toolRoot = '/opt/robo-work-tools/node_modules';
export const toolPaths = {
    node: '/usr/local/bin/node',
    claude: `${toolRoot}/@anthropic-ai/claude-code/bin/claude.exe`,
    opencode: `${toolRoot}/opencode-ai/bin/opencode.exe`,
};
export const wrapperTargets = {
    codex: `${toolRoot}/@openai/codex/bin/codex.js`,
    claude: toolPaths.claude,
    opencode: toolPaths.opencode,
    pi: `${toolRoot}/@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
};
export function createContract(read = fs.readFileSync, architecture = process.arch) {
    const versions = new Set(Object.values(toolPaths).flatMap((file) => requiredVersions(read(file))));
    for (const version of versions) {
        if (/^(GLIBC|GLIBCXX|CXXABI)_/.test(version) && !/^(GLIBC|GLIBCXX|CXXABI)_[0-9]+(?:\.[0-9]+)+$/.test(version)) {
            throw new Error(`unsupported-version: injected tool requires ${version}`);
        }
    }
    const selected = (prefix) => [...versions].filter((value) => new RegExp(`^${prefix}_[0-9]+(?:\\.[0-9]+)+$`).test(value))
        .map((value) => value.slice(prefix.length + 1)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const glibcVersions = selected('GLIBC');
    if (!glibcVersions.length) throw new Error('injected tools have no GLIBC requirements');
    if (!['x64', 'arm64'].includes(architecture)) throw new Error(`unsupported architecture ${architecture}`);
    for (const file of Object.values(wrapperTargets)) read(file);
    return { schemaVersion: 1, architecture: architecture === 'x64' ? 'amd64' : 'arm64',
        glibcFloor: glibcVersions.at(-1), glibcxxVersions: selected('GLIBCXX'), cxxabiVersions: selected('CXXABI'),
        tools: toolPaths, wrapperTargets, caBundle: '/opt/robo-work-runtime/ca/ca-bundle.crt',
        injections: { node: '/rw-opt/node/bin/node', tools: '/rw-opt/tools', ca: '/rw-opt/ca/ca-bundle.crt', bin: '/rw-opt/bin' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const destination = '/opt/robo-work-runtime/environment-contract.json';
    fs.writeFileSync(destination, `${JSON.stringify(createContract(), null, 2)}\n`, { mode: 0o444 });
}
