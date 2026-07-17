import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = fs.readFileSync(path.join(root, 'images/livekit-egress-loopback/Dockerfile'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish-livekit-egress-loopback.yml'), 'utf8');

test('patched Egress rebuild pins source, templates, build base, runtime, and toolchain bytes', () => {
  assert.match(dockerfile, /EGRESS_SOURCE_COMMIT=ba52a026bea409bde31dcc7da9ba5322e967520c/);
  assert.match(dockerfile, /EGRESS_SOURCE_ARCHIVE_SHA256=[0-9a-f]{64}/);
  assert.match(dockerfile, /livekit\/gstreamer:1\.22\.12-dev@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /livekit\/egress-templates:sha-fe250b1@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /livekit\/egress:v1\.9\.1@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /go1\.23\.1\.linux-/);
  assert.match(dockerfile, /echo "\$\{go_sha\}  \/tmp\/go\.tar\.gz" \| sha256sum -c -/);
});

test('patch is narrow, guarded, and produces loopback-only health binding', () => {
  assert.match(dockerfile, /grep -Fq 'http\.ListenAndServe\(fmt\.Sprintf\(":%d", conf\.HealthPort\)/);
  assert.match(dockerfile, /http\.ListenAndServe\(fmt\.Sprintf\("127\.0\.0\.1:%d", conf\.HealthPort\)/);
  assert.match(dockerfile, /! grep -Fq 'http\.ListenAndServe\(fmt\.Sprintf\(":%d", conf\.HealthPort\)/);
  assert.match(dockerfile, /io\.ploinky\.patch="egress-health-7981-loopback-only"/);
  assert.match(dockerfile, /livekit-egress-loopback-v5\.contract/);
  assert.match(dockerfile, /binary_sha256=/);
  assert.match(dockerfile, /chmod 0444/);
});

test('publication workflow verifies exact bytes before mutation and proves same-namespace semantics and bridge denial', () => {
  assert.match(workflow, /\.CpuLoad \| numbers/);
  assert.match(workflow, /LiveKit Egress/);
  assert.match(workflow, /0100007F:1F2D/);
  assert.match(workflow, /00000000:1F2D/);
  assert.match(workflow, /--network "\$network" --entrypoint curl/);
  assert.match(workflow, /--platform linux\/amd64,linux\/arm64/);
  assert.match(workflow, /expected_digest:[\s\S]*required:\s*true/);
  assert.match(workflow, /Verify archive digest and platform set before registry mutation/);
  assert.match(workflow, /skopeo copy --all/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
});
