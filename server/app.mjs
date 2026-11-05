import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuth, HttpError } from './auth.mjs';
import { createRpc } from './rpc.mjs';

const DEFAULT_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const MAX_JSON_BYTES = 32 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
    "worker-src 'self' blob:", "font-src 'self'", "object-src 'none'",
    "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
  res.setHeader('Cache-Control', 'no-store');
}

function json(req, res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.setHeader('Cache-Control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : text);
}

function requireMethod(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    throw new HttpError(405, '不支持此请求方法。', 'METHOD_NOT_ALLOWED');
  }
}

function parsePublicOrigin(raw) {
  if (!raw) return null;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('HGHUB_PUBLIC_ORIGIN 必须是完整的 HTTP(S) 来源，例如 https://hghub.example.com。');
  }
  return url.origin;
}

function checkMutation(req, publicOrigin) {
  if (req.headers['x-hghub-request'] !== '1') {
    throw new HttpError(403, '缺少请求校验头，请从 HGhub 网页操作。', 'ORIGIN_REJECTED');
  }
  let expected = publicOrigin;
  if (!expected) {
    try {
      const host = req.headers.host;
      if (!host || /[/\\\s@]/.test(host)) throw new Error('Invalid host');
      expected = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${host}`).origin;
    } catch {
      throw new HttpError(400, '请求主机格式不正确。', 'INVALID_HOST');
    }
  }
  if (req.headers.origin !== expected) {
    throw new HttpError(403, '请求来源不匹配，请检查网页地址和 HGHUB_PUBLIC_ORIGIN。', 'ORIGIN_REJECTED');
  }
}

async function readJson(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, '请求必须使用 application/json。', 'INVALID_CONTENT_TYPE');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_JSON_BYTES) throw new HttpError(413, '请求内容过大。', 'BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  // Leave the socket alive long enough to return 413 when a chunked body is too large.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, '请求内容过大。', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '请求不是有效的 JSON。', 'INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求参数必须是 JSON 对象。', 'INVALID_INPUT');
  }
  return body;
}

async function serveStatic(req, res, url, distDir) {
  requireMethod(req, res, ['GET', 'HEAD']);
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { throw new HttpError(400, '地址编码不正确。', 'INVALID_PATH'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) {
    throw new HttpError(404, '未找到文件。', 'NOT_FOUND');
  }
  const root = resolve(distDir);
  let target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) throw new HttpError(404, '未找到文件。', 'NOT_FOUND');
  let info;
  try {
    info = await stat(target);
    if (info.isDirectory()) { target = join(target, 'index.html'); info = await stat(target); }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    // Missing assets must not return HTML (which hides broken builds in browsers).
    if (extname(decoded) || decoded.startsWith('/assets/')) {
      throw new HttpError(404, '未找到文件。', 'NOT_FOUND');
    }
    target = join(root, 'index.html');
    try { info = await stat(target); }
    catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(503, '前端尚未构建，请先运行 pnpm build。', 'FRONTEND_NOT_BUILT');
      throw error;
    }
  }
  if (!info.isFile()) throw new HttpError(404, '未找到文件。', 'NOT_FOUND');
  // Do not expose a secret outside dist even if somebody adds a symlink to it.
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!realTarget.startsWith(realRoot + sep)) throw new HttpError(404, '未找到文件。', 'NOT_FOUND');
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(target).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  res.setHeader('Cache-Control', target.endsWith('.html') ? 'no-cache'
    : decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(realTarget), res);
}

/** Inject network/media in tests; importing this module never starts a listener. */
export async function createApp(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = resolve(options.dataDir ?? env.HGHUB_DATA_DIR ?? './data');
  const distDir = resolve(options.distDir ?? DEFAULT_DIST);
  const publicOrigin = parsePublicOrigin(options.publicOrigin ?? env.HGHUB_PUBLIC_ORIGIN ?? env.PUBLIC_ORIGIN);
  const cookieSecure = options.cookieSecure ?? (env.HGHUB_COOKIE_SECURE === 'true' || publicOrigin?.startsWith('https://') || false);
  const auth = await createAuth({
    dataDir,
    authDisabled: options.authDisabled ?? (env.HGHUB_AUTH_DISABLED === 'true'),
    adminUsername: options.adminUsername ?? env.HGHUB_ADMIN_USERNAME ?? 'admin',
    adminPassword: options.adminPassword ?? env.HGHUB_ADMIN_PASSWORD,
    cookieSecure,
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
  });
  const network = options.network ?? await (await import('./net.mjs')).createNetwork({ dataDir, env });
  const media = options.media ?? (await import('./media.mjs')).createMediaHandler({ network });
  const rpc = createRpc({ network, auth, media });

  async function browserSession(req, res) {
    const { session, cookie } = await auth.getOrCreate(req);
    if (cookie) res.setHeader('Set-Cookie', cookie);
    return session;
  }

  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 }, async (req, res) => {
    securityHeaders(res);
    try {
      if (!req.url || req.url.length > 16_384 || !req.url.startsWith('/')) {
        throw new HttpError(400, '请求地址无效或过长。', 'INVALID_PATH');
      }
      const url = new URL(req.url, 'http://hghub.invalid');
      const pathname = url.pathname;
      if (pathname === '/healthz') {
        requireMethod(req, res, ['GET', 'HEAD']);
        json(req, res, 200, { ok: true });
        return;
      }
      if (pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) checkMutation(req, publicOrigin);
        if (pathname === '/api/auth/session') {
          requireMethod(req, res, ['GET']);
          const session = await browserSession(req, res);
          json(req, res, 200, { authenticated: Boolean(session), username: session?.username ?? null,
            loginRequired: auth.loginRequired });
          return;
        }
        if (pathname === '/api/auth/login') {
          requireMethod(req, res, ['POST']);
          const body = await readJson(req);
          const { session, cookie } = await auth.login(req, body);
          if (cookie) res.setHeader('Set-Cookie', cookie);
          json(req, res, 200, { authenticated: true, username: session.username, loginRequired: auth.loginRequired });
          return;
        }
        if (pathname === '/api/auth/logout') {
          requireMethod(req, res, ['POST']);
          res.setHeader('Set-Cookie', await auth.logout(req));
          json(req, res, 200, { ok: true });
          return;
        }

        const session = await browserSession(req, res);
        if (!session) {
          res.setHeader('Set-Cookie', auth.clearCookie());
          throw new HttpError(401, '请先登录网页。', 'AUTH_REQUIRED');
        }
        if (pathname === '/api/settings') {
          requireMethod(req, res, ['GET', 'PUT']);
          if (req.method === 'PUT') {
            const body = await readJson(req);
            if (typeof body.proxyUrl !== 'string' || body.proxyUrl.length > 2048) {
              throw new HttpError(400, '代理地址格式不正确。', 'INVALID_INPUT');
            }
            await network.setProxy(body.proxyUrl);
            media.clear();
          }
          json(req, res, 200, network.getSettings());
          return;
        }
        if (pathname === '/api/settings/test') {
          requireMethod(req, res, ['POST']);
          json(req, res, 200, await network.diagnose());
          return;
        }
        const match = /^\/api\/rpc\/([a-z_]+)$/.exec(pathname);
        if (match) {
          requireMethod(req, res, ['POST']);
          const data = await rpc(match[1], await readJson(req), session);
          json(req, res, 200, { data: data === undefined ? null : data });
          return;
        }
        throw new HttpError(404, '未找到接口。', 'NOT_FOUND');
      }
      if (pathname.startsWith('/media/')) {
        requireMethod(req, res, ['GET', 'HEAD']);
        if (auth.loginRequired && !auth.get(req)) throw new HttpError(401, '请先登录网页。', 'AUTH_REQUIRED');
        await media.handle(req, res, url);
        return;
      }
      if (pathname === '/api' || pathname === '/media') throw new HttpError(404, '未找到接口。', 'NOT_FOUND');
      await serveStatic(req, res, url, distDir);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (status === 413) res.setHeader('Connection', 'close');
      if (status === 500) console.error('[server] Request failed:', error.code ?? error.name ?? 'Error');
      json(req, res, status, {
        error: status === 500 ? '服务端处理失败，请检查容器日志和数据目录权限。' : String(error.message).slice(0, 500),
        code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
      });
    }
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 500;

  return {
    server, auth, network, media,
    async close({ force = false } = {}) {
      const stopped = server.listening ? new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeIdleConnections();
        if (force) server.closeAllConnections();
      }) : Promise.resolve();
      network.close?.();
      await Promise.all([stopped, auth.close()]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await createApp();
    const port = Number(process.env.HGHUB_PORT ?? process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
    const host = process.env.HGHUB_HOST ?? process.env.HOST ?? '0.0.0.0';
    await new Promise((resolveListen, rejectListen) => {
      app.server.once('error', rejectListen);
      app.server.listen(port, host, () => { app.server.off('error', rejectListen); resolveListen(); });
    });
    console.info(`[HGhub] Web server listening on ${host}:${port}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        await app.close({ force: true });
        process.exitCode = 0;
      });
    }
  } catch (error) {
    console.error(`[HGhub] ${error.message}`);
    process.exitCode = 1;
  }
}
