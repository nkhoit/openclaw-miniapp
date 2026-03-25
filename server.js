const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { URL } = require('url');
const { requireTelegramAuth } = require('./lib/telegram-auth');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const PORT = Number(process.env.PORT || 3001);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WORKSPACE = process.env.WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace-main');
const ALLOWED_USER_IDS = String(process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const authenticate = requireTelegramAuth({
  botToken: BOT_TOKEN,
  allowedUserIds: ALLOWED_USER_IDS,
});

function runCommand(file, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error: error ? error.message : null,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

function readFileSafe(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Unknown';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseJsonSafe(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

async function getOpenClawStatus() {
  const result = await runCommand('openclaw', ['status', '--json']);
  if (!result.ok) {
    return {
      ok: false,
      online: false,
      version: 'unknown',
      model: 'unknown',
      uptime: null,
      activeSessions: 0,
      raw: null,
      error: result.error || result.stderr || 'openclaw status unavailable',
    };
  }

  const raw = parseJsonSafe(result.stdout, null);
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      online: false,
      version: 'unknown',
      model: 'unknown',
      uptime: null,
      activeSessions: 0,
      raw: null,
      error: 'openclaw status returned invalid JSON',
    };
  }

  const version = raw.version || raw.openclawVersion || raw.cliVersion || 'unknown';
  const model = raw.default_model || raw.defaultModel || raw.model || raw.runtime?.model || 'unknown';
  const gateway = raw.gateway || {};
  const runtime = raw.runtime || {};
  const sessions = raw.sessions || {};
  const activeSessions = Number(
    sessions.active ?? raw.activeSessions ?? runtime.activeSessions ?? 0
  ) || 0;

  return {
    ok: true,
    online: Boolean(gateway.running ?? raw.online ?? true),
    version,
    model,
    uptime: gateway.uptime || raw.uptime || runtime.uptime || null,
    activeSessions,
    raw,
    error: null,
  };
}

async function getCpuUsagePercent() {
  const result = await runCommand('/bin/sh', ['-c', "ps -A -o %cpu= | awk '{s+=$1} END {printf \"%.1f\", s}'"]);
  const parsed = Number.parseFloat(result.stdout.trim());
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.min(parsed, 100));
  }

  const load = os.loadavg()[0] || 0;
  const cores = os.cpus().length || 1;
  return Math.max(0, Math.min((load / cores) * 100, 100));
}

async function getDiskStats() {
  const result = await runCommand('/bin/df', ['-k', WORKSPACE]);
  if (!result.ok) {
    return {
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      usedPercent: null,
      mount: '/',
      error: result.error || 'df failed',
    };
  }

  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const targetLine = lines[lines.length - 1] || '';
  const parts = targetLine.split(/\s+/);
  if (parts.length < 6) {
    return {
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      usedPercent: null,
      mount: '/',
      error: 'Unable to parse df output',
    };
  }

  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  const freeKb = Number(parts[3]);
  const usedPercent = Number(String(parts[4]).replace('%', ''));
  const mount = parts.slice(5).join(' ');

  return {
    totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : null,
    usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : null,
    freeBytes: Number.isFinite(freeKb) ? freeKb * 1024 : null,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    mount,
    error: null,
  };
}

async function getSystemStats() {
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = totalMemoryBytes - freeMemoryBytes;
  const cpuUsagePercent = await getCpuUsagePercent();
  const disk = await getDiskStats();

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: {
      cores: os.cpus().length,
      usagePercent: cpuUsagePercent,
      loadAverage: os.loadavg(),
    },
    memory: {
      totalBytes: totalMemoryBytes,
      usedBytes: usedMemoryBytes,
      freeBytes: freeMemoryBytes,
      usedPercent: totalMemoryBytes > 0 ? Number(((usedMemoryBytes / totalMemoryBytes) * 100).toFixed(1)) : null,
      total: formatBytes(totalMemoryBytes),
      used: formatBytes(usedMemoryBytes),
      free: formatBytes(freeMemoryBytes),
    },
    disk: {
      ...disk,
      total: formatBytes(disk.totalBytes),
      used: formatBytes(disk.usedBytes),
      free: formatBytes(disk.freeBytes),
    },
  };
}

function collectFallbackActivity() {
  const files = [
    path.join(WORKSPACE, 'memory', 'audit', `${new Date().toISOString().slice(0, 10)}.md`),
    path.join(WORKSPACE, 'NOW.md'),
  ];

  const messages = [];
  for (const filePath of files) {
    const content = readFileSafe(filePath, '');
    if (!content) {
      continue;
    }

    const lines = content.split(/\r?\n/).filter(Boolean).slice(-10);
    for (const line of lines.reverse()) {
      messages.push({
        timestamp: new Date().toISOString(),
        role: 'system',
        preview: line.slice(0, 120),
      });
      if (messages.length >= 10) {
        return messages;
      }
    }
  }

  return messages;
}

function extractMessagesFromUnknownJson(value, bucket) {
  if (!value || bucket.length >= 10) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractMessagesFromUnknownJson(item, bucket);
      if (bucket.length >= 10) {
        return;
      }
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const candidateText = value.preview || value.content || value.text || value.message || value.body;
  const candidateRole = value.role || value.authorRole || value.sender || value.kind;
  const candidateTimestamp = value.timestamp || value.createdAt || value.time || value.date;

  if (typeof candidateText === 'string' && candidateText.trim()) {
    bucket.push({
      timestamp: candidateTimestamp || new Date().toISOString(),
      role: String(candidateRole || 'unknown'),
      preview: candidateText.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }

  const keysToSearch = ['messages', 'items', 'sessions', 'data', 'results'];
  for (const key of keysToSearch) {
    if (key in value) {
      extractMessagesFromUnknownJson(value[key], bucket);
      if (bucket.length >= 10) {
        return;
      }
    }
  }
}

async function getRecentActivity() {
  const result = await runCommand('openclaw', ['sessions', '--active', '1440', '--json']);
  if (result.ok) {
    const parsed = parseJsonSafe(result.stdout, null);
    const messages = [];
    extractMessagesFromUnknownJson(parsed, messages);
    if (messages.length > 0) {
      return {
        ok: true,
        source: 'openclaw sessions --active 1440 --json',
        messages: messages.slice(0, 10),
        error: null,
      };
    }
  }

  return {
    ok: false,
    source: 'workspace fallback',
    messages: collectFallbackActivity(),
    error: result.error || result.stderr || 'Unable to read OpenClaw sessions',
  };
}

async function getContext() {
  const nowPath = path.join(WORKSPACE, 'NOW.md');
  const nowMd = readFileSafe(nowPath, 'NOW.md not found.');
  return {
    workspace: WORKSPACE,
    nowPath,
    nowMd,
  };
}

async function getUsage() {
  const result = await runCommand('openclaw', ['status', '--json']);
  const parsed = result.ok ? parseJsonSafe(result.stdout, null) : null;
  const usage = parsed && typeof parsed === 'object' ? (parsed.usage || parsed.tokens || parsed.cost || {}) : {};
  return {
    ok: result.ok,
    source: 'openclaw status --json',
    usage,
    error: result.ok ? null : (result.error || result.stderr || 'Usage unavailable'),
  };
}

async function getDashboard() {
  const [status, system, context, activity, usage] = await Promise.all([
    getOpenClawStatus(),
    getSystemStats(),
    getContext(),
    getRecentActivity(),
    getUsage(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    status,
    system,
    context,
    activity,
    usage,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(html);
}

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
    if (!auth) {
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          status: await getOpenClawStatus(),
          system: await getSystemStats(),
        });
      }

      if (req.method === 'GET' && pathname === '/api/context') {
        return sendJson(res, 200, await getContext());
      }

      if (req.method === 'GET' && pathname === '/api/activity') {
        return sendJson(res, 200, await getRecentActivity());
      }

      if (req.method === 'GET' && pathname === '/api/usage') {
        return sendJson(res, 200, await getUsage());
      }

      if (req.method === 'GET' && pathname === '/api/dashboard') {
        return sendJson(res, 200, await getDashboard());
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(res, 500, {
        error: 'Internal server error',
        detail: error && error.message ? error.message : String(error),
      });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`OpenClaw Mini App server listening on http://127.0.0.1:${PORT}`);
});
