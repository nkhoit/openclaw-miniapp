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
  // Try npm-global path (common on Linux with custom npm prefix)
  const npmGlobalPath = path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw', 'package.json');
  if (existsSync(npmGlobalPath)) {
    const pkg = parseJsonSafe(readFileSafe(npmGlobalPath), null);
    if (pkg?.version) return pkg.version;
  }
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
  // Try global require resolution
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
// Parse ps etime format (MM:SS, HH:MM:SS, or DD-HH:MM:SS) into human-readable
function formatEtime(etime) {
  const dayMatch = etime.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    const [, d, h, m] = dayMatch.map(Number);
    return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
  }
  const parts = etime.trim().split(':').map(Number);
  if (parts.length === 3) {
    const [h, m] = parts;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  return etime;
}

function formatSeconds(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function getGatewayUptime() {
  // macOS: launchctl
  const lc = await runCommand('/bin/sh', ['-c', "launchctl list 2>/dev/null | awk '/ai\\.openclaw\\.gateway/ {print $1}'"], 2000);
  const pid = lc.stdout.trim();
  if (pid && /^\d+$/.test(pid)) {
    const ps = await runCommand('/bin/ps', ['-p', pid, '-o', 'etime='], 2000);
    const etime = ps.stdout.trim();
    if (etime) return formatEtime(etime);
  }
  // Linux: systemctl
  const sc = await runCommand('/bin/sh', ['-c', "systemctl show openclaw --property=ActiveEnterTimestamp --value 2>/dev/null"], 2000);
  if (sc.ok && sc.stdout.trim()) {
    const started = new Date(sc.stdout.trim());
    if (!isNaN(started)) {
      return formatSeconds(Math.floor((Date.now() - started.getTime()) / 1000));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sessions — read sessions.json directly (instant, no CLI)
// ---------------------------------------------------------------------------
function getSessionData() {
  // Find the agent with the most sessions
  const agentsDir = path.join(OPENCLAW_STATE, 'agents');
  let bestPath = null, bestCount = 0;
  try {
    for (const agent of readdirSync(agentsDir)) {
      const sp = path.join(agentsDir, agent, 'sessions', 'sessions.json');
      if (!existsSync(sp)) continue;
      const raw = parseJsonSafe(readFileSafe(sp), null);
      const count = raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
      if (count > bestCount) { bestPath = sp; bestCount = count; }
    }
  } catch {}
  if (!bestPath) return { count: 0, model: 'unknown', sessions: [] };
  const raw = parseJsonSafe(readFileSafe(bestPath), null);
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
  const identity = getIdentity();

  return {
    ok: true,
    online: gateway.online,
    version: OPENCLAW_VERSION,
    model: sessionData.model,
    uptime: uptime || null,
    activeSessions: sessionData.count,
    identity,
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

async function getGpuStats() {
  // NVIDIA
  const nv = await runCommand('nvidia-smi', [
    '--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits'
  ], 3000);
  if (nv.ok) {
    const gpus = nv.stdout.trim().split('\n').map(line => {
      const [name, memUsed, memTotal, utilization, temp] = line.split(',').map(s => s.trim());
      return {
        name,
        memUsed: Number(memUsed), memTotal: Number(memTotal),
        memUsedFormatted: formatBytes(Number(memUsed) * 1024 * 1024),
        memTotalFormatted: formatBytes(Number(memTotal) * 1024 * 1024),
        memPercent: Number(memTotal) > 0 ? Math.round((Number(memUsed) / Number(memTotal)) * 100) : null,
        utilization: Number(utilization),
        tempC: Number(temp),
      };
    });
    return { available: true, provider: 'nvidia', gpus };
  }
  // AMD ROCm
  const amd = await runCommand('rocm-smi', ['--showmeminfo', 'vram', '--csv'], 3000);
  if (amd.ok && amd.stdout.includes('vram')) {
    return { available: true, provider: 'amd', raw: amd.stdout.trim() };
  }
  return { available: false };
}

async function getSystemStats() {
  const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;
  const [cpuPercent, disk, gpu] = await Promise.all([getCpuUsagePercent(), getDiskStats(), getGpuStats()]);
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
    gpu,
  };
}

// ---------------------------------------------------------------------------
// Identity — read IDENTITY.md for agent name and emoji
// ---------------------------------------------------------------------------
function getIdentity() {
  const idPath = path.join(WORKSPACE, 'IDENTITY.md');
  const content = readFileSafe(idPath, '');
  if (!content) return { name: 'OpenClaw', emoji: null };
  const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
  const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(.+)/);
  const name = nameMatch ? nameMatch[1].trim() : 'OpenClaw';
  const emoji = emojiMatch ? emojiMatch[1].trim().replace(/—/, '').trim() || null : null;
  return { name, emoji };
}

// ---------------------------------------------------------------------------
// Workspace cards — configurable via CARDS env var (comma-separated filenames)
// ---------------------------------------------------------------------------
const CARD_FILES = String(process.env.CARDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function getCards() {
  return CARD_FILES.map(file => {
    const filePath = path.join(WORKSPACE, file);
    const content = readFileSafe(filePath, '');
    const name = path.basename(file, path.extname(file));
    return { file, name, content: content || null };
  }).filter(c => c.content !== null);
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
    cards: getCards(),
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

  // Serve static files from public/
  if (req.method === 'GET' && !pathname.startsWith('/api/') && pathname !== '/healthz') {
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(filePath).pipe(res);
    }
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
      if (req.method === 'GET' && pathname === '/api/cards') return sendJson(res, 200, getCards());
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
