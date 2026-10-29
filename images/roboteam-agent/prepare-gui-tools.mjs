// Build-time only. Runtime services execute the installed payload directly.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const lock = JSON.parse(await readFile(new URL('sources.lock.json', root), 'utf8'));
const mode = process.argv[2];
assert.ok(['browser', 'desktop'].includes(mode), 'Expected browser or desktop');
const selection = lock.guiTools[mode];
for (const name of ['package.json', 'package-lock.json']) {
    const bytes = await readFile(new URL(name, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), selection.files[name], `${name} hash differs`);
}
if (mode === 'desktop') {
    const release = lock.guiTools.computerUseLinux;
    const asset = release.platforms[`linux/${process.arch === 'x64' ? 'amd64' : process.arch}`];
    assert.ok(process.platform === 'linux' && asset, 'Unsupported computer-use-linux platform');
    const license = await readFile(new URL('computer-use-linux.LICENSE', root));
    assert.equal(createHash('sha256').update(license).digest('hex'), release.license.sha256, 'License hash differs');
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `Release download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, asset.size, 'Release size differs');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, 'Release digest differs');
    await writeFile(new URL('computer-use-linux', root), bytes, { mode: 0o755 });
}
