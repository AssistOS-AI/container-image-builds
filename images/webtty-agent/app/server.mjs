import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '7681', 10) || 7681;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_ROOT = path.resolve(process.env.WEBTTY_WORKSPACE_ROOT || '/workspace');
const SESSION_COOKIE = 'webtty_agent_sid';
const MAX_GLOBAL_TTYS = 20;
const MAX_CONCURRENT_TTYS = 3;
const MIN_RECONNECT_INTERVAL_MS = 1000;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;

const sessions = new Map();

function parseCookies(req) {
  const cookies = new Map();
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    cookies.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return cookies;
}

function buildSessionCookie(req, sid) {
  const parts = [
    `${SESSION_COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (req.headers['x-forwarded-proto'] === 'https') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function ensureSession(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies.get(SESSION_COOKIE);
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, { tabs: new Map(), createdAt: Date.now() });
    res.setHeader('Set-Cookie', buildSessionCookie(req, sid));
  }
  return sessions.get(sid);
}

function getSession(req) {
  const sid = parseCookies(req).get(SESSION_COOKIE);
  return sid ? sessions.get(sid) : null;
}

function countGlobalTabs() {
  let count = 0;
  for (const session of sessions.values()) {
    count += session.tabs.size;
  }
  return count;
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function sendJson(res, status, value) {
  sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function isInside(parent, target) {
  const rel = path.relative(parent, target);
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function safePublicPath(relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch (_) {
    return null;
  }
  const target = path.resolve(PUBLIC_DIR, decoded);
  if (!isInside(PUBLIC_DIR, target)) return null;
  return target;
}

function serveAsset(req, res, relPath) {
  const target = safePublicPath(relPath);
  if (!target) return sendText(res, 400, 'Bad asset path');

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return sendText(res, 404, 'Not Found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not Found');

  res.writeHead(200, {
    'Content-Type': contentTypeFor(target),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(target).pipe(res);
}

function renderIndex() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'webtty.html'), 'utf8');
  const replacements = {
    __AGENT_NAME__: process.env.WEBTTY_AGENT_NAME || 'WebTTY Agent',
    __CONTAINER_NAME__: process.env.WEBTTY_CONTAINER_NAME || os.hostname() || '-',
    __RUNTIME__: 'local',
    __REQUIRES_AUTH__: 'false',
    __BASE_PATH__: '.'
  };
  let rendered = html;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(key).join(String(value));
  }
  return rendered;
}

function serveIndex(req, res) {
  ensureSession(req, res);
  sendText(res, 200, renderIndex(), 'text/html; charset=utf-8');
}

function resolveWorkspaceDir(dirParam) {
  const value = String(dirParam || '').trim();
  if (!value || value === '.') {
    return assertWorkspaceDir(WORKSPACE_ROOT);
  }
  if (value.includes('\0')) {
    throw new Error('Invalid working directory');
  }

  const normalized = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error('Working directory must be workspace-relative');
  }

  const resolved = path.resolve(WORKSPACE_ROOT, normalized);
  if (!isInside(WORKSPACE_ROOT, resolved)) {
    throw new Error('Working directory escapes /workspace');
  }
  return assertWorkspaceDir(resolved);
}

function assertWorkspaceDir(target) {
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync.native(WORKSPACE_ROOT);
    realTarget = fs.realpathSync.native(target);
  } catch (_) {
    throw new Error('Working directory not found');
  }
  if (!isInside(realRoot, realTarget)) {
    throw new Error('Working directory escapes /workspace');
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isDirectory()) {
    throw new Error('Working directory is not a directory');
  }
  return realTarget;
}

function createTTY(cwd) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor'
  };

  return pty.spawn('/bin/bash', [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd,
    env
  });
}

function writeSseFrame(tab, frame) {
  if (tab.sseRes && !tab.sseRes.destroyed) {
    tab.sseRes.write(frame);
    return;
  }
  tab.outputBuffer.push(frame);
  if (tab.outputBuffer.length > 100) {
    tab.outputBuffer.splice(0, tab.outputBuffer.length - 100);
  }
}

function removeTab(session, tabId, tab) {
  if (tab.cleanupTimer) {
    clearTimeout(tab.cleanupTimer);
    tab.cleanupTimer = null;
  }
  tab.sseRes = null;
  session.tabs.delete(tabId);
}

function killTab(session, tabId, tab) {
  if (!tab || tab.closed) return;
  tab.closed = true;
  const pid = tab.pid || tab.tty?.pid || null;

  try {
    if (typeof tab.tty?.dispose === 'function') tab.tty.dispose();
    else if (typeof tab.tty?.kill === 'function') tab.tty.kill();
  } catch (_) {
    // best effort
  }

  removeTab(session, tabId, tab);

  if (pid) {
    tab.cleanupTimer = setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
        console.warn(`[webtty] Force killed lingering process ${pid}`);
      } catch (_) {
        // process already exited
      }
    }, 2000);
    tab.cleanupTimer.unref?.();
  }
}

function createTab(session, tabId, cwd) {
  const tab = {
    tty: null,
    sseRes: null,
    lastConnectTime: Date.now(),
    createdAt: Date.now(),
    pid: null,
    outputBuffer: [],
    cleanupTimer: null,
    closed: false
  };

  const tty = createTTY(cwd);
  tab.tty = tty;
  tab.pid = tty.pid || null;

  tty.onData((data) => {
    writeSseFrame(tab, `data: ${JSON.stringify(data)}\n\n`);
  });
  tty.onExit(() => {
    if (tab.sseRes && !tab.sseRes.destroyed) {
      tab.sseRes.write('event: close\n');
      tab.sseRes.write('data: {}\n\n');
      tab.sseRes.end();
    }
    tab.closed = true;
    removeTab(session, tabId, tab);
  });

  session.tabs.set(tabId, tab);
  return tab;
}

function attachSse(req, res, session, tabId, tab) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'alt-svc': 'clear'
  });
  res.write(': connected\n\n');

  if (tab.sseRes && tab.sseRes !== res && !tab.sseRes.destroyed) {
    try { tab.sseRes.end(); } catch (_) {}
  }
  tab.sseRes = res;
  tab.lastConnectTime = Date.now();

  for (const frame of tab.outputBuffer.splice(0)) {
    res.write(frame);
  }

  req.on('close', () => {
    if (tab.sseRes === res) {
      killTab(session, tabId, tab);
    }
  });
}

function findTab(req, tabId) {
  const session = getSession(req);
  if (!session || !tabId) return null;
  return session.tabs.get(tabId) || null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleStream(req, res, parsedUrl) {
  const tabId = parsedUrl.searchParams.get('tabId');
  if (!tabId) return sendText(res, 400, 'Missing tabId');

  const session = ensureSession(req, res);
  let tab = session.tabs.get(tabId);
  const now = Date.now();

  if (tab && tab.lastConnectTime && (now - tab.lastConnectTime) < MIN_RECONNECT_INTERVAL_MS) {
    res.writeHead(429, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '1'
    });
    res.end('Reconnecting too fast. Please wait.');
    return;
  }

  if (!tab && countGlobalTabs() >= MAX_GLOBAL_TTYS) {
    res.writeHead(503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '30'
    });
    res.end('Server at capacity. Please try again later.');
    return;
  }

  if (!tab && session.tabs.size >= MAX_CONCURRENT_TTYS) {
    res.writeHead(429, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '5'
    });
    res.end('Too many concurrent connections. Please close other tabs or wait.');
    return;
  }

  if (!tab) {
    let cwd;
    try {
      cwd = resolveWorkspaceDir(parsedUrl.searchParams.get('dir'));
    } catch (err) {
      return sendText(res, 400, err?.message || 'Invalid working directory');
    }

    try {
      tab = createTab(session, tabId, cwd);
    } catch (err) {
      return sendText(res, 500, `Failed to create TTY: ${err?.message || err}`);
    }
  }

  attachSse(req, res, session, tabId, tab);
}

async function handleInput(req, res, parsedUrl) {
  const tabId = parsedUrl.searchParams.get('tabId');
  const tab = findTab(req, tabId);
  if (!tab) return sendText(res, 400, 'Unknown tab');

  let body;
  try {
    body = await readBody(req, MAX_INPUT_BYTES);
  } catch (_) {
    return sendText(res, 413, 'Request body too large');
  }

  try {
    tab.tty.write(body.toString('utf8'));
  } catch (_) {
    // terminal may already be closed
  }
  res.writeHead(204);
  res.end();
}

async function handleResize(req, res, parsedUrl) {
  const tabId = parsedUrl.searchParams.get('tabId');
  const tab = findTab(req, tabId);
  if (!tab) return sendText(res, 400, 'Unknown tab');

  let parsed;
  try {
    parsed = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}');
  } catch (_) {
    return sendText(res, 400, 'Invalid resize payload');
  }

  const cols = Number(parsed.cols);
  const rows = Number(parsed.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    return sendText(res, 400, 'Invalid terminal size');
  }

  try {
    tab.tty.resize(cols, rows);
  } catch (_) {
    // terminal may already be closed
  }
  res.writeHead(204);
  res.end();
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/webtty.html')) {
    return serveIndex(req, res);
  }

  if (req.method === 'GET' && pathname.startsWith('/assets/')) {
    return serveAsset(req, res, pathname.substring('/assets/'.length));
  }

  if (req.method === 'GET' && pathname === '/whoami') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/stream') {
    return handleStream(req, res, parsedUrl);
  }

  if (req.method === 'POST' && pathname === '/input') {
    return handleInput(req, res, parsedUrl);
  }

  if (req.method === 'POST' && pathname === '/resize') {
    return handleResize(req, res, parsedUrl);
  }

  return sendText(res, 404, 'Not Found');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      sendText(res, 500, `Internal Server Error: ${err?.message || err}`);
    } else {
      res.destroy(err);
    }
  });
});

function shutdown() {
  for (const [sid, session] of sessions.entries()) {
    for (const [tabId, tab] of session.tabs.entries()) {
      killTab(session, tabId, tab);
    }
    sessions.delete(sid);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`webtty-agent listening on ${HOST}:${PORT}`);
});
