import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  supabaseUrl: trimTrailingSlash(requiredEnv('SUPABASE_URL')),
  supabaseKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  adminUsername: requiredEnv('ADMIN_USERNAME'),
  adminPassword: requiredEnv('ADMIN_PASSWORD'),
  sessionSecret: requiredEnv('SESSION_SECRET'),
  cookieSecure: String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true',
  maxRows: Number(process.env.MAX_ROWS || 5000)
};

const sessions = new Map();
const sessionTtlMs = 1000 * 60 * 60 * 12;
const cookieName = 'awny_dashboard_session';
const conversationColumns = [
  'id',
  'telegram_user_id',
  'telegram_chat_id',
  'telegram_message_id',
  'direction',
  'message_text',
  'bot_response',
  'telegram_username',
  'telegram_first_name',
  'telegram_last_name',
  'workflow_id',
  'execution_id',
  'raw_payload',
  'created_at'
].join(',');

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/login') return await handleLogin(req, res);
    if (req.method === 'POST' && url.pathname === '/logout') return await withAuth(req, res, handleLogout);
    if (req.method === 'GET' && url.pathname === '/api/session') return await withAuth(req, res, handleSession);
    if (req.method === 'GET' && url.pathname === '/api/users') return await withAuth(req, res, () => handleUsers(req, res, url));
    if (req.method === 'GET' && /^\/api\/users\/[^/]+\/conversations$/.test(url.pathname)) {
      return await withAuth(req, res, () => handleUserConversations(req, res, url));
    }
    if (req.method === 'GET' && url.pathname === '/api/export.json') return await withAuth(req, res, () => handleJsonExport(req, res, url));
    if (req.method === 'GET' && url.pathname === '/api/export.csv') return await withAuth(req, res, () => handleCsvExport(req, res, url));

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request failed:', error);
    return sendJson(res, 500, { error: 'تعذر تنفيذ الطلب. تحقق من إعدادات السيرفر وسجلات التشغيل.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Awny dashboard listening on http://${config.host}:${config.port}`);
});

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');

  if (!safeEqual(username, config.adminUsername) || !safeEqual(password, config.adminPassword)) {
    return sendJson(res, 401, { error: 'بيانات الدخول غير صحيحة.' });
  }

  const sessionId = crypto.randomBytes(32).toString('base64url');
  sessions.set(sessionId, {
    username,
    expiresAt: Date.now() + sessionTtlMs
  });
  res.setHeader('Set-Cookie', buildSessionCookie(sessionId));
  return sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  sessions.delete(req.session.id);
  res.setHeader('Set-Cookie', clearSessionCookie());
  return sendJson(res, 200, { ok: true });
}

function handleSession(req, res) {
  return sendJson(res, 200, { authenticated: true, username: req.session.username });
}

async function handleUsers(req, res, url) {
  const q = normalizeSearch(url.searchParams.get('q'));
  const rows = await fetchConversations();
  const users = aggregateUsers(rows)
    .filter((user) => !q || user.searchText.includes(q))
    .sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))
    .map(stripSearchText);
  return sendJson(res, 200, { data: users });
}

async function handleUserConversations(req, res, url) {
  const telegramUserId = decodeURIComponent(url.pathname.split('/')[3]);
  const rows = await fetchConversations({ telegramUserId });
  rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const user = aggregateUsers(rows)[0] || null;
  return sendJson(res, 200, {
    user: user ? stripSearchText(user) : null,
    data: rows.map(formatConversation)
  });
}

async function handleJsonExport(req, res, url) {
  const rows = await fetchConversations({ telegramUserId: url.searchParams.get('telegramUserId') });
  rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.setHeader('Content-Disposition', 'attachment; filename="awny-conversations.json"');
  return sendJson(res, 200, { exported_at: new Date().toISOString(), data: rows.map(formatConversation) });
}

async function handleCsvExport(req, res, url) {
  const rows = await fetchConversations({ telegramUserId: url.searchParams.get('telegramUserId') });
  rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="awny-conversations.csv"'
  });
  res.end(toCsv(rows.map(formatConversation)));
}

async function fetchConversations(options = {}) {
  const params = new URLSearchParams();
  params.set('select', conversationColumns);
  params.set('order', 'created_at.desc');
  params.set('limit', String(config.maxRows));
  if (options.telegramUserId) {
    params.set('telegram_user_id', `eq.${String(options.telegramUserId)}`);
  }

  const response = await fetchWithRetry(`${config.supabaseUrl}/rest/v1/telegram_conversations?${params}`, {
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${detail}`);
  }

  return response.json();
}

async function fetchWithRetry(url, options) {
  const delays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (attempt >= delays.length || !isTransientNetworkError(error)) throw error;
      await sleep(delays[attempt]);
    }
  }
}

function isTransientNetworkError(error) {
  const code = error?.cause?.code || error?.code;
  return ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aggregateUsers(rows) {
  const byUser = new Map();
  for (const row of rows) {
    const key = String(row.telegram_user_id || row.telegram_chat_id || 'unknown');
    const current = byUser.get(key) || {
      telegram_user_id: key,
      telegram_chat_id: row.telegram_chat_id,
      telegram_username: row.telegram_username || '',
      telegram_first_name: row.telegram_first_name || '',
      telegram_last_name: row.telegram_last_name || '',
      display_name: displayName(row),
      message_count: 0,
      conversation_ids: [],
      execution_ids: [],
      first_seen: row.created_at,
      last_seen: row.created_at,
      latest_message: ''
    };

    current.message_count += 1;
    current.conversation_ids.push(row.id);
    if (row.execution_id) current.execution_ids.push(row.execution_id);
    if (new Date(row.created_at) > new Date(current.last_seen)) {
      current.last_seen = row.created_at;
      current.latest_message = row.message_text || '';
      current.telegram_chat_id = row.telegram_chat_id;
      current.telegram_username = row.telegram_username || current.telegram_username;
      current.telegram_first_name = row.telegram_first_name || current.telegram_first_name;
      current.telegram_last_name = row.telegram_last_name || current.telegram_last_name;
      current.display_name = displayName(row);
    }
    if (new Date(row.created_at) < new Date(current.first_seen)) {
      current.first_seen = row.created_at;
    }
    current.searchText = normalizeSearch([
      current.telegram_user_id,
      current.telegram_chat_id,
      current.telegram_username,
      current.telegram_first_name,
      current.telegram_last_name,
      current.display_name,
      current.latest_message
    ].join(' '));
    byUser.set(key, current);
  }

  return [...byUser.values()].map((user) => ({
    ...user,
    execution_ids: [...new Set(user.execution_ids)].slice(0, 25),
    conversation_ids: user.conversation_ids.slice(0, 100)
  }));
}

function formatConversation(row) {
  return {
    id: row.id,
    telegram_user_id: row.telegram_user_id,
    telegram_chat_id: row.telegram_chat_id,
    telegram_message_id: row.telegram_message_id,
    direction: row.direction,
    message_text: row.message_text || '',
    bot_response: row.bot_response || '',
    telegram_username: row.telegram_username || '',
    telegram_first_name: row.telegram_first_name || '',
    telegram_last_name: row.telegram_last_name || '',
    workflow_id: row.workflow_id || '',
    execution_id: row.execution_id || '',
    created_at: row.created_at,
    raw_payload: row.raw_payload || null
  };
}

function toCsv(rows) {
  const headers = [
    'id',
    'telegram_user_id',
    'telegram_chat_id',
    'telegram_message_id',
    'telegram_username',
    'telegram_first_name',
    'telegram_last_name',
    'message_text',
    'bot_response',
    'workflow_id',
    'execution_id',
    'created_at'
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return `\ufeff${lines.join('\n')}\n`;
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden' });

  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return sendJson(res, 404, { error: 'Not found' });
    const content = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(content);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
}

function withAuth(req, res, handler) {
  const sessionId = readSignedSession(req);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (sessionId) sessions.delete(sessionId);
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  req.session = { ...session, id: sessionId };
  return handler(req, res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function displayName(row) {
  const name = [row.telegram_first_name, row.telegram_last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (row.telegram_username) return `@${row.telegram_username}`;
  return `مستخدم ${row.telegram_user_id || row.telegram_chat_id || 'غير معروف'}`;
}

function stripSearchText(user) {
  const copy = { ...user };
  delete copy.searchText;
  return copy;
}

function normalizeSearch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .trim();
}

function buildSessionCookie(sessionId) {
  const signed = `${sessionId}.${sign(sessionId)}`;
  const secure = config.cookieSecure ? '; Secure' : '';
  return `${cookieName}=${signed}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`;
}

function clearSessionCookie() {
  const secure = config.cookieSecure ? '; Secure' : '';
  return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function readSignedSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(cookieHeader.split(';').map((part) => {
    const [key, ...rest] = part.trim().split('=');
    return [key, rest.join('=')];
  }).filter(([key]) => key));
  const value = cookies[cookieName];
  if (!value) return null;
  const [sessionId, signature] = value.split('.');
  if (!sessionId || !signature) return null;
  return safeEqual(signature, sign(sessionId)) ? sessionId : null;
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadDotEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  let content = '';
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
