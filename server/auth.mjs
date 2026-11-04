import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const COOKIE_NAME = 'hghub_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 512;
const MAX_RATE_ENTRIES = 2048;

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED', retryAfter) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const digest = (value) => createHash('sha256').update(value).digest();
const sessionId = (token) => digest(token).toString('hex');

function readCookie(req) {
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      const token = value.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    }
  }
  return null;
}

/** Retain only profile fields consumed by the UI, never account credentials. */
export function publicUser(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = [
    'id', 'username', 'nickname', 'avatar', 'avatar_color', 'sign', 'desc',
    'user_type', 'channel_code', 'counts', 'interactions',
  ];
  const user = {};
  for (const key of allowed) {
    if (Object.hasOwn(value, key)) user[key] = value[key];
  }
  return user;
}

/**
 * One deployment account, independent browser sessions. Only a hash of each
 * browser cookie is stored. Platform tokens stay in this private server file.
 */
export async function createAuth({
  dataDir,
  adminUsername = 'admin',
  adminPassword,
  cookieSecure = false,
  sessionTtlMs = SESSION_TTL_MS,
  now = Date.now,
}) {
  if (typeof adminUsername !== 'string' || !adminUsername.trim() || adminUsername.length > 128) {
    throw new Error('HGHUB_ADMIN_USERNAME 必须是 1–128 个字符。');
  }
  adminUsername = adminUsername.trim();
  if (typeof adminPassword !== 'string' || adminPassword.length < 12 || adminPassword.length > 256) {
    throw new Error('请设置 HGHUB_ADMIN_PASSWORD，长度需为 12–256 个字符。');
  }
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error('Invalid session lifetime');
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = join(dataDir, 'sessions.json');
  let saved;
  try {
    saved = JSON.parse(await readFile(stateFile, 'utf8'));
    if (saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.salt ?? '')) {
      throw new Error('Invalid session file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('无法读取会话数据，请检查数据目录中的 sessions.json。', { cause: error });
    }
  }

  const salt = saved?.salt ?? randomBytes(32).toString('hex');
  const expectedKey = await deriveKey(adminPassword, salt, 64);
  const expectedUsername = digest(adminUsername);
  // Changing either configured credential invalidates cookies saved by older runs.
  const credentialId = createHmac('sha256', expectedKey).update(adminUsername).digest('hex');
  const sessions = new Map();
  if (saved?.credentialId === credentialId && Array.isArray(saved.sessions)) {
    for (const entry of saved.sessions.slice(-MAX_SESSIONS)) {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.id ?? '') ||
          entry.username !== adminUsername || !Number.isFinite(entry.createdAt) ||
          !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now()) continue;
      const token = typeof entry.upstream?.token === 'string' && entry.upstream.token.length <= 16_384
        ? entry.upstream.token : '';
      sessions.set(entry.id, {
        id: entry.id, username: adminUsername,
        createdAt: entry.createdAt, expiresAt: entry.expiresAt,
        upstream: { token, user: publicUser(entry.upstream?.user) },
        revision: Number.isSafeInteger(entry.revision) ? entry.revision : 0,
      });
    }
  }

  let writes = Promise.resolve();
  function persist() {
    const text = JSON.stringify({ version: 1, salt, credentialId, sessions: [...sessions.values()] });
    const write = async () => {
      const tmp = `${stateFile}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(tmp, stateFile);
      } finally {
        await rm(tmp, { force: true });
      }
    };
    // A failed write must not prevent a later logout from removing a session.
    const pending = writes.then(write, write);
    writes = pending.catch(() => {});
    return pending;
  }

  function pruneSessions() {
    const timestamp = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
    }
  }

  function get(req) {
    const token = readCookie(req);
    if (!token) return null;
    const id = sessionId(token);
    const session = sessions.get(id);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(id);
      return null;
    }
    return session;
  }

  function isCurrent(session) {
    return session && sessions.get(session.id) === session && session.expiresAt > now();
  }

  const limits = new Map();
  let activeLogins = 0;
  function limitFor(ip) {
    const timestamp = now();
    for (const [key, value] of limits) {
      if (value.until <= timestamp) limits.delete(key);
    }
    let value = limits.get(ip);
    if (!value) {
      if (limits.size >= MAX_RATE_ENTRIES) limits.delete(limits.keys().next().value);
      value = { count: 0, until: timestamp + RATE_WINDOW_MS };
      limits.set(ip, value);
    }
    return value;
  }

  function cookie(token, maxAge = Math.floor(sessionTtlMs / 1000)) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;
  }

  async function login(req, credentials) {
    const username = typeof credentials?.username === 'string' ? credentials.username.trim() : '';
    const password = credentials?.password;
    if (!username || username.length > 128 || typeof password !== 'string' || !password || password.length > 256) {
      throw new HttpError(400, '请输入有效的用户名和密码。', 'INVALID_INPUT');
    }
    // Deliberately do not trust X-Forwarded-For: it is spoofable without a
    // separately configured trusted reverse-proxy boundary.
    const ip = req.socket?.remoteAddress ?? 'unknown';
    const limit = limitFor(ip);
    if (limit.count >= 10 || activeLogins >= 4) {
      throw new HttpError(429, '登录尝试过于频繁，请稍后再试。', 'RATE_LIMITED',
        limit.count >= 10 ? Math.max(1, Math.ceil((limit.until - now()) / 1000)) : 2);
    }
    limit.count += 1;
    activeLogins += 1;
    let valid;
    try {
      const candidate = await deriveKey(password, salt, 64);
      const passwordMatches = timingSafeEqual(candidate, expectedKey);
      const usernameMatches = timingSafeEqual(digest(username), expectedUsername);
      valid = passwordMatches && usernameMatches;
    } finally {
      activeLogins -= 1;
    }
    if (!valid) throw new HttpError(401, '用户名或密码错误。', 'INVALID_CREDENTIALS');

    limits.delete(ip);
    const previous = get(req);
    if (previous) sessions.delete(previous.id);
    pruneSessions();
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: sessionId(token), username: adminUsername,
      createdAt: now(), expiresAt: now() + sessionTtlMs,
      upstream: { token: '', user: null }, revision: 0,
    };
    sessions.set(session.id, session);
    try {
      await persist();
    } catch (error) {
      sessions.delete(session.id);
      throw error;
    }
    return { session, cookie: cookie(token) };
  }

  async function logout(req) {
    const session = get(req);
    if (session) {
      sessions.delete(session.id);
      await persist();
    }
    return cookie('', 0);
  }

  async function setUpstream(session, token, user, expectedRevision = session.revision) {
    if (!isCurrent(session)) throw new HttpError(401, '网页登录已过期，请重新登录。', 'AUTH_REQUIRED');
    if (session.revision !== expectedRevision) {
      throw new HttpError(409, '账号状态已更新，请重试。', 'SESSION_CHANGED');
    }
    if (typeof token !== 'string' || token.length > 16_384 || /[\r\n]/.test(token)) {
      throw new HttpError(502, '平台返回的登录凭据无效。', 'UPSTREAM_ERROR');
    }
    session.upstream = { token, user: publicUser(user) };
    session.revision += 1;
    await persist();
  }

  await persist();
  return {
    get, login, logout, setUpstream, isCurrent,
    clearCookie: () => cookie('', 0),
    close: () => writes,
  };
}
