import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exact = (...parts) => new RegExp(`\\b${parts.join('_')}\\b`);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literalPattern = (...parts) => new RegExp(escapeRegExp(parts.join('')));
const retiredVersionedArtifactPatterns = [
  ['retired versioned WebTTY start script', literalPattern('webtty', '-v', '5', '-start')],
  ['retired versioned WebTTY contract', literalPattern('webtty', '-v', '5', '.contract')],
  ['retired versioned WebTTY public archive', literalPattern('public', '-v', '5', '.tar')],
  ['retired versioned OnlyOffice contract', literalPattern('onlyoffice', '-v', '5', '.contract')],
  ['retired versioned DocService marker', literalPattern('docservice', '-v', '5', '-port-8000')],
  ['retired versioned OnlyOffice script environment', literalPattern('ONLYOFFICE_', 'V', '5', '_CONFIGURE_SCRIPT')],
  ['retired versioned source-absence path', literalPattern('lib/', 'v', '5', '-source-absence.test.mjs')],
  ['retired versioned Document Server script', literalPattern('configure-document-server-', 'v', '5')],
  ['retired versioned support-listener script', literalPattern('configure-support-listeners-', 'v', '5')],
  ['retired versioned LiveKit Egress contract', literalPattern('livekit-egress-loopback-', 'v', '5', '.contract')],
  ['retired versioned install directory', literalPattern('.ploinky-install-', 'v', '5')],
  ['retired versioned GPTResearcher lock', literalPattern('gpt-researcher-', 'v', '5', '-lock-1')],
  ['retired versioned OnlyOffice session file', literalPattern('onlyoffice-sessions-', 'v', '5', '.json')],
  ['retired versioned smoke generation age variable', literalPattern('SMOKE_', 'V', '5', '_MAX_GENERATION_AGE_MS')],
  ['retired versioned smoke image age variable', literalPattern('SMOKE_', 'V', '5', '_MAX_IMAGE_AGE_MS')],
  ['retired versioned smoke evidence variable', literalPattern('SMOKE_SCREEN_', 'V', '5', '_BOX_EVIDENCE')],
];
const FORBIDDEN = [
  [['retired', ['web', 'publishing'].join('-'), 'agent'].join(' '), new RegExp(`\\b${['basic', ['web', 'publishing'].join('-')].join('/')}\\b`)],
  [['retired', ['web', 'publishing'].join('-'), 'component'].join(' '), new RegExp(`\\b${['web', 'publishing'].join('-')}\\b`, 'i')],
  ['retired basic cloudflared component', new RegExp(`\\b${['basic', 'cloudflared'].join('/')}\\b`, 'i')],
  ['retired standalone cloudflared agent', new RegExp(`\\b${['cloudflared', 'agent'].join('-')}\\b`, 'i')],
  ['retired publication environment', new RegExp(`\\b${['WEB', 'PUBLISHING'].join('_')}_[A-Z0-9_]*\\b`)],
  ['retired OnlyOffice public URL', exact('ONLYOFFICE', 'PUBLIC', 'URL')],
  ['retired OnlyOffice internal URL', exact('ONLYOFFICE', 'INTERNAL', 'URL')],
  ['retired OnlyOffice callback base URL', exact('ONLYOFFICE', 'CALLBACK', 'BASE', 'URL')],
  ['retired WebMeet LiveKit environment', new RegExp(`\\bWEBMEET_[A-Z0-9_]*${['LIVE', 'KIT'].join('')}[A-Z0-9_]*\\b`)],
  ['retired WebMeet TURN environment', new RegExp(`\\b${['WEBMEET', 'TURN'].join('_')}_[A-Z0-9_]*\\b`)],
  ['retired WebMeet TLS hostname', exact('WEBMEET', 'TLS', 'HOSTNAME')],
  ['retired WebMeet certificate email', exact('WEBMEET', 'CERT', 'EMAIL')],
  ['retired private Router host publication', /(?:8081\/tcp|0\.0\.0\.0:8081:8081|127\.0\.0\.1:8081:8081)/],
  ...retiredVersionedArtifactPatterns,
];

test('edge-routing active source omits retired edge-publication symbols', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const violations = [];
  for (const relative of files) {
    if (relative.startsWith('docs/superpowers/')) continue;
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(source)) violations.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});
