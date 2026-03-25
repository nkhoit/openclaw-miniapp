const http = require('http');
const fs = require('fs');
const { readdirSync, existsSync } = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { URL } = require('url');
const { requireTelegramAuth } = require('./lib/telegram-auth');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3001);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WORKSPACE = process.env.WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace-main');
const OPENCLAW_STATE = process.env.OPENCLAW_STATE || path.join(os.homedir(), '.openclaw');
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:18789';
const ALLOWED_USER_IDS = String(process.env.ALLOWED_USER_IDS || '')
  .split(',').map(v => v.trim()).filter(Boolean);

const authenticate = requireTelegramAuth({
  botToken: BOT_TOKEN,
  allowedUserIds: ALLOWED_USER_IDS,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readFileSafe(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return fallback; }
}

function parseJsonSafe(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function runCommand(file, args, timeout = 3000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error?.message || null, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ---------------------------------------------------------------------------
// Version — read from openclaw's package.json (instant, no subprocess)
// ---------------------------------------------------------------------------
function getOpenClawVersion() {
  // Try known nvm paths
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      const pkgPath = path.join(nvmDir, v, 'lib', 'node_modules', 'openclaw', 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = parseJsonSafe(readFileSafe(pkgPath), null);
        if (pkg?.version) return pkg.version;
      }
    }
  } catch {}
  // Try global
  try {
    const globalPkg = require.resolve('openclaw/package.json');
    const pkg = parseJsonSafe(readFileSafe(globalPkg), null);
    if (pkg?.version) return pkg.version;
  } catch {}
  return 'unknown';
}

const OPENCLAW_VERSION = getOpenClawVersion();

// ---------------------------------------------------------------------------
// Gateway health — quick HTTP ping (no CLI)
// ---------------------------------------------------------------------------
async function checkGatewayHealth() {
  return new Promise(resolve => {
    const url = new URL('/healthz', GATEWAY_URL);
    const req = http.get(url, { timeout: 2000 }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ online: res.statusCode === 200, statusCode: res.statusCode });
      });
    });
    req.on('error', () => resolve({ online: false, statusCode: null }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, statusCode: null }); });
  });
}

// ---------------------------------------------------------------------------
// Gateway uptime — from launchctl/systemctl PID → ps etime
// ---------------------------------------------------------------------------
async function getGatewayUptime() {
  // macOS: launchctl
  const lc = await runCommand('/bin/sh', ['-c', "launchctl list 2>/dev/null | awk '/openclaw/ {print $1}'"], 2000);
  const pid = lc.stdout.trim();
  if (pid && /^\d+$/.test(pid)) {
    const ps = await runCommand('/bin/ps', ['-p', pid, '-o', 'etime='], 2000);
    const etime = ps.stdout.trim();
    if (etime) return etime;
  }
  // Linux: systemctl
  const sc = await runCommand('/bin/sh', ['-c', "systemctl show openclaw --property=ActiveEnterTimestamp --value 2>/dev/null"], 2000);
  if (sc.ok && sc.stdout.trim()) {
    const started = new Date(sc.stdout.trim());
    if (!isNaN(started)) {
      const secs = Math.floor((Date.now() - started.getTime()) / 1000);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sessions — read sessions.json directly (instant, no CLI)
// ---------------------------------------------------------------------------
function getSessionData() {
  const sessionsPath = path.join(OPENCLAW_STATE, 'agents', 'default', 'sessions', 'sessions.json');
  const raw = parseJsonSafe(readFileSafe(sessionsPath), null);
  if (!raw) return { count: 0, model: 'unknown', sessions: [] };

  // sessions.json is a flat object keyed by session key
  const entries = Object.entries(raw);
  const sessions = entries.map(([key, s]) => ({
    key,
    model: s.model || 'unknown',
    updatedAt: s.updatedAt || 0,
    totalTokens: s.totalTokens || 0,
    inputTokens: s.inputTokens || 0,
    outputTokens: s.outputTokens || 0,
    contextTokens: s.contextTokens || 0,
    percentUsed: s.contextTokens ? Math.round((s.totalTokens / s.contextTokens) * 100) : 0,
  })).sort((a, b) => b.updatedAt - a.updatedAt);

  // Default model from the most active session or first one
  const defaultModel = sessions[0]?.model || 'unknown';

  return { count: entries.length, model: defaultModel, sessions };
}

// ---------------------------------------------------------------------------
// Agent Status (assembled from file reads + HTTP ping)
// ---------------------------------------------------------------------------
async function getOpenClawStatus() {
  const [gateway, uptime] = await Promise.all([
    checkGatewayHealth(),
    getGatewayUptime(),
  ]);
  const sessionData = getSessionData();

  return {
    ok: true,
    online: gateway.online,
    version: OPENCLAW_VERSION,
    model: sessionData.model,
    uptime: uptime || null,
    activeSessions: sessionData.count,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// System stats
// ---------------------------------------------------------------------------
async function getCpuUsagePercent() {
  // macOS: use top snapshot for accurate current usage
  const result = await runCommand('/usr/bin/top', ['-l', '1', '-n', '0'], 5000);
  if (result.ok) {
    const match = result.stdout.match(/CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys/);
    if (match) return Math.min(parseFloat(match[1]) + parseFloat(match[2]), 100);
  }
  // Fallback: load average
  const load = os.loadavg()[0] || 0;
  return Math.max(0, Math.min((load / os.cpus().length) * 100, 100));
}

async function getDiskStats() {
  const result = await runCommand('/bin/df', ['-k', WORKSPACE], 2000);
  if (!result.ok) return { totalBytes: null, usedBytes: null, freeBytes: null, usedPercent: null, mount: '/', error: result.error };
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const parts = (lines[lines.length - 1] || '').split(/\s+/);
  if (parts.length < 6) return { totalBytes: null, usedBytes: null, freeBytes: null, usedPercent: null, mount: '/', error: 'parse error' };
  const [, totalKb, usedKb, freeKb, usedPct] = parts.map(Number);
  return {
    totalBytes: totalKb * 1024, usedBytes: usedKb * 1024, freeBytes: freeKb * 1024,
    usedPercent: Number(String(parts[4]).replace('%', '')), mount: parts.slice(5).join(' '), error: null,
  };
}

async function getSystemStats() {
  const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;
  const [cpuPercent, disk] = await Promise.all([getCpuUsagePercent(), getDiskStats()]);
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: { cores: os.cpus().length, usagePercent: cpuPercent, loadAverage: os.loadavg() },
    memory: {
      totalBytes: totalMem, usedBytes: usedMem, freeBytes: freeMem,
      usedPercent: totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : null,
      total: formatBytes(totalMem), used: formatBytes(usedMem), free: formatBytes(freeMem),
    },
    disk: { ...disk, total: formatBytes(disk.totalBytes), used: formatBytes(disk.usedBytes), free: formatBytes(disk.freeBytes) },
  };
}

// ---------------------------------------------------------------------------
// Context — read NOW.md
// ---------------------------------------------------------------------------
function getContext() {
  const nowPath = path.join(WORKSPACE, 'NOW.md');
  return { workspace: WORKSPACE, nowPath, nowMd: readFileSafe(nowPath, 'NOW.md not found.') };
}

// ---------------------------------------------------------------------------
// Recent activity — from sessions.json (no CLI)
// ---------------------------------------------------------------------------
function getRecentActivity() {
  const sessionData = getSessionData();
  const messages = sessionData.sessions.slice(0, 10).map(s => {
    // Clean up the session key for display
    const label = s.key
      .replace(/^agent:default:/, '')
      .replace(/:run:[a-f0-9-]+$/, '')
      .replace(/:[a-f0-9-]{36}$/, '');
    const ago = s.updatedAt ? timeSince(s.updatedAt) : 'unknown';
    return {
      timestamp: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
      role: label,
      preview: `${s.model} · ${s.totalTokens.toLocaleString()} tokens · ${ago}`,
    };
  });
  return { ok: true, source: 'sessions.json', messages, error: null };
}

function timeSince(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Usage — aggregate from sessions.json
// ---------------------------------------------------------------------------
function getUsage() {
  const sessionData = getSessionData();
  let totalTokens = 0, totalInput = 0, totalOutput = 0;
  const modelCounts = {};
  for (const s of sessionData.sessions) {
    totalTokens += s.totalTokens;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    modelCounts[s.model] = (modelCounts[s.model] || 0) + 1;
  }
  return {
    ok: true, source: 'sessions.json',
    usage: { totalTokens, totalInput, totalOutput, sessionCount: sessionData.count, modelDistribution: modelCounts },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Dashboard — all data in one call
// ---------------------------------------------------------------------------
async function getDashboard() {
  const [status, system] = await Promise.all([getOpenClawStatus(), getSystemStats()]);
  return {
    generatedAt: new Date().toISOString(),
    status,
    system,
    context: getContext(),
    activity: getRecentActivity(),
    usage: getUsage(),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && pathname === '/') {
    return sendHtml(res, 200, readFileSafe(INDEX_FILE, '<h1>index.html not found</h1>'));
  }
  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }
  if (pathname.startsWith('/api/')) {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, 200, { generatedAt: new Date().toISOString(), status: await getOpenClawStatus(), system: await getSystemStats() });
      }
      if (req.method === 'GET' && pathname === '/api/context') return sendJson(res, 200, getContext());
      if (req.method === 'GET' && pathname === '/api/activity') return sendJson(res, 200, getRecentActivity());
      if (req.method === 'GET' && pathname === '/api/usage') return sendJson(res, 200, getUsage());
      if (req.method === 'GET' && pathname === '/api/dashboard') return sendJson(res, 200, await getDashboard());
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(res, 500, { error: 'Internal server error', detail: error?.message || String(error) });
    }
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`OpenClaw Mini App server listening on http://127.0.0.1:${PORT}`);
});
