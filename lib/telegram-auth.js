const crypto = require('crypto');

const AUTH_MAX_AGE_SECONDS = 300;

function timingSafeEqualHex(a, b) {
  const aBuffer = Buffer.from(String(a || ''), 'hex');
  const bBuffer = Buffer.from(String(b || ''), 'hex');
  if (aBuffer.length === 0 || bBuffer.length === 0 || aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseInitData(initData) {
  const params = new URLSearchParams(String(initData || ''));
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

function buildDataCheckString(data) {
  return Object.keys(data)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('\n');
}

function parseTelegramUser(data) {
  if (!data.user) {
    return null;
  }

  try {
    return JSON.parse(data.user);
  } catch (_) {
    return null;
  }
}

function validateInitData(initData, botToken, maxAgeSeconds = AUTH_MAX_AGE_SECONDS) {
  if (!initData) {
    return { ok: false, status: 401, error: 'Missing Telegram initData' };
  }

  if (!botToken) {
    return { ok: false, status: 500, error: 'BOT_TOKEN is not configured' };
  }

  const data = parseInitData(initData);
  if (!data.hash) {
    return { ok: false, status: 401, error: 'Telegram initData hash is missing' };
  }

  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate)) {
    return { ok: false, status: 401, error: 'Telegram initData auth_date is invalid' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - authDate) > maxAgeSeconds) {
    return { ok: false, status: 401, error: 'Telegram initData expired' };
  }

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(buildDataCheckString(data))
    .digest('hex');

  if (!timingSafeEqualHex(expectedHash, data.hash)) {
    return { ok: false, status: 401, error: 'Telegram initData signature is invalid' };
  }

  const user = parseTelegramUser(data);
  return { ok: true, data, user };
}

function isAllowedUser(user, allowedUserIds) {
  if (!user || !user.id) {
    return false;
  }

  const allowed = new Set((allowedUserIds || []).map((value) => String(value).trim()).filter(Boolean));
  if (allowed.size === 0) {
    return false;
  }

  return allowed.has(String(user.id));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function requireTelegramAuth(options = {}) {
  const { botToken, allowedUserIds, maxAgeSeconds = AUTH_MAX_AGE_SECONDS } = options;

  return function telegramAuth(req, res) {
    const initData = req.headers['x-telegram-init-data'];
    const validation = validateInitData(initData, botToken, maxAgeSeconds);

    if (!validation.ok) {
      sendJson(res, validation.status, {
        error: validation.error,
      });
      return null;
    }

    if (!isAllowedUser(validation.user, allowedUserIds)) {
      sendJson(res, 403, {
        error: 'Telegram user is not allowed',
      });
      return null;
    }

    req.telegram = {
      initData: validation.data,
      user: validation.user,
    };

    return req.telegram;
  };
}

module.exports = {
  AUTH_MAX_AGE_SECONDS,
  parseInitData,
  buildDataCheckString,
  validateInitData,
  isAllowedUser,
  requireTelegramAuth,
};
