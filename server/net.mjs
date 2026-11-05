import http from 'node:http';
import https from 'node:https';
import { lookup as lookupProxyEndpoint } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { ProxyAgent } from 'proxy-agent';
import ipaddr from 'ipaddr.js';

const DEFAULT_BASE = 'https://huangguoai.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const decompressors = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) };

export class NetworkError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateProxy(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000]/.test(value)) {
    throw new NetworkError('代理地址格式不正确', 400, 'INVALID_PROXY');
  }
  const text = value.trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new NetworkError('请输入完整的代理地址，例如 http://host:7890', 400, 'INVALID_PROXY'); }
  if (!PROXY_PROTOCOLS.has(url.protocol) || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new NetworkError('代理仅支持 HTTP、HTTPS、SOCKS5、SOCKS5H，不能包含路径或查询参数', 400, 'INVALID_PROXY');
  }
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); }
  catch { throw new NetworkError('代理用户名或密码的 URL 编码不正确', 400, 'INVALID_PROXY'); }
  return url.href.replace(/\/$/, '');
}

function maskProxy(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.username || url.password) { url.username = '***'; url.password = '***'; }
  return url.href.replace(/\/$/, '');
}

function cleanHost(hostname) { return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); }

export function isPublicAddress(address) {
  try {
    // process() also normalizes IPv4-mapped IPv6, so ::ffff:127.0.0.1 cannot bypass this check.
    return ipaddr.process(cleanHost(address)).range() === 'unicast';
  } catch { return false; }
}

function isAllowedHost(hostname, patterns) {
  const host = cleanHost(hostname);
  return patterns.some((pattern) => pattern.startsWith('*.')
    ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
    : host === pattern);
}

function parseHosts(value) {
  return value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((pattern) => {
    const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    if (!host || /[\s/:@?#\\]/.test(host) || host.includes('*') || (!host.includes('.') && host !== 'localhost')) {
      throw new Error('HGHUB_MEDIA_HOSTS 必须是逗号分隔的域名，可使用 *.example.com');
    }
    return pattern;
  });
}

function networkMessage(error) {
  if (error instanceof NetworkError) return error;
  const code = error?.code;
  if (code === 'ABORT_ERR') return new NetworkError('请求已取消', 499, 'REQUEST_ABORTED');
  if (code === 'ETIMEDOUT') return new NetworkError('连接超时，请检查代理地址和网络', 504, 'NETWORK_TIMEOUT');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new NetworkError('无法解析服务器地址，请检查网络或代理', 502, 'NETWORK_DNS');
  if (code === 'ECONNREFUSED') return new NetworkError('连接被拒绝，请确认代理已启动并允许容器访问', 502, 'NETWORK_REFUSED');
  // Do not expose arbitrary agent error text: it can contain proxy credentials and signed URLs.
  return new NetworkError('上游连接失败，请检查网络、代理或服务器证书', 502, 'NETWORK_ERROR');
}

async function readJsonBody(response) {
  let size = 0;
  const parts = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) { response.body.destroy(); throw new NetworkError('上游响应过大'); }
    parts.push(chunk);
  }
  let bytes = Buffer.concat(parts);
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
  if (encoding && encoding !== 'identity') {
    const decode = decompressors[encoding];
    if (!decode) throw new NetworkError('上游响应使用了不支持的压缩格式');
    bytes = await decode(bytes, { maxOutputLength: MAX_JSON_BYTES });
  }
  const text = bytes.toString('utf8');
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { throw new NetworkError('上游未返回有效 JSON，请检查服务地址或代理'); }
}

/** One outbound transport for APIs, covers, playlists and media; never inherits host proxy env implicitly. */
export async function createNetwork({ dataDir, env = process.env, upstreamBase, allowPrivateUpstream = false, allowedMediaHosts } = {}) {
  const base = new URL(upstreamBase || env.HGHUB_UPSTREAM_BASE || DEFAULT_BASE);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('HGHUB_UPSTREAM_BASE 必须是完整的 HTTP/HTTPS 站点根地址');
  }
  const baseOrigin = base.origin;
  const mediaHosts = [cleanHost(base.hostname), '*.drleao.cn', '*.hzjvlo.cn', ...parseHosts(env.HGHUB_MEDIA_HOSTS || ''), ...(allowedMediaHosts || [])];
  const settingsFile = join(dataDir || './data', 'settings.json');
  const environmentProxy = validateProxy(env.HGHUB_PROXY || '');
  let savedProxy;
  try {
    const parsed = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (typeof parsed.proxyUrl !== 'string') throw new Error('missing proxyUrl');
    savedProxy = validateProxy(parsed.proxyUrl);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 data/settings.json，请检查格式和目录权限');
  }
  let activeProxy = savedProxy === undefined ? environmentProxy : savedProxy;
  let saving = Promise.resolve();
  let closed = false;

  const safeLookup = (hostname, options, callback) => {
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!allowPrivateUpstream && addresses.some((entry) => !isPublicAddress(entry.address))) {
        callback(new NetworkError('禁止访问内网或保留地址', 400, 'UNSAFE_TARGET')); return;
      }
      const matching = opts.family ? addresses.filter((entry) => entry.family === opts.family) : addresses;
      if (!matching.length) { callback(Object.assign(new Error('DNS address not found'), { code: 'ENOTFOUND' })); return; }
      if (opts.all) callback(null, matching);
      else callback(null, matching[0].address, matching[0].family);
    }, callback);
  };
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 8, lookup: safeLookup });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 8, lookup: safeLookup });
  const agent = new ProxyAgent({
    httpAgent, httpsAgent, getProxyForUrl: () => activeProxy, maxSockets: 48,
    // socks-proxy-agent retains URL brackets around an IPv6 proxy hostname.
    // Its socket lookup must normalize those brackets, but allow LAN proxies.
    socketOptions: {
      lookup(hostname, options, callback) {
        lookupProxyEndpoint(hostname.replace(/^\[|\]$/g, ''), options, callback);
      },
    },
  });

  function validateTarget(value, media) {
    let target;
    try { target = new URL(value); } catch { throw new NetworkError('媒体地址无效', 400, 'INVALID_TARGET'); }
    if (target.href.length > 8192 || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
      throw new NetworkError('只允许不含用户名密码的 HTTP/HTTPS 地址', 400, 'INVALID_TARGET');
    }
    const hostname = cleanHost(target.hostname);
    if (!allowPrivateUpstream && (hostname === 'localhost' || hostname.endsWith('.localhost') || (ipaddr.isValid(hostname) && !isPublicAddress(hostname)))) {
      throw new NetworkError('禁止访问内网或保留地址', 400, 'UNSAFE_TARGET');
    }
    if (media ? !isAllowedHost(hostname, mediaHosts) : target.origin !== baseOrigin) {
      throw new NetworkError(media ? '媒体域名未获允许，请在 HGHUB_MEDIA_HOSTS 中添加可信域名' : '上游请求不能跳转到其他站点', 400, 'TARGET_NOT_ALLOWED');
    }
    return target;
  }

  async function request(value, { method = 'GET', headers = {}, body, signal, media = false } = {}) {
    if (closed) throw new NetworkError('服务正在停止', 503);
    let target = validateTarget(value, media);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const response = await new Promise((resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.request(target, {
          // SOCKS5 resolves the destination using the request's lookup option.
          // HTTP(S) proxies and SOCKS5H resolve remotely at the trusted proxy.
          method, agent, signal, lookup: safeLookup,
          headers: { 'User-Agent': USER_AGENT, Referer: `${baseOrigin}/`, 'Accept-Encoding': 'identity', ...headers },
        });
        const timeout = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 20_000);
        timeout.unref();
        req.setTimeout(30_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.once('error', (error) => { clearTimeout(timeout); reject(networkMessage(error)); });
        req.once('response', (incoming) => {
          clearTimeout(timeout);
          resolve({ status: incoming.statusCode, headers: incoming.headers, body: incoming, url: target.href });
        });
        req.end(body);
      });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) return response;
      response.body.destroy();
      if (redirect === 5) throw new NetworkError('上游重定向次数过多');
      // Never replay credentials/mutations to a redirected endpoint or change POST into GET.
      if (!['GET', 'HEAD'].includes(method)) throw new NetworkError('上游接口发生重定向，请更新 HGHUB_UPSTREAM_BASE');
      const redirected = validateTarget(new URL(response.headers.location, target).href, media);
      if (target.protocol === 'https:' && redirected.protocol !== 'https:') throw new NetworkError('拒绝不安全的 HTTPS 降级重定向');
      target = redirected;
    }
    throw new NetworkError('上游重定向失败');
  }

  async function edge(method, path, payload, token) {
    if (!['GET', 'POST', 'DELETE'].includes(method) || typeof path !== 'string' || !path.startsWith('/api/') || /[\r\n\u0000\\]/.test(path)) {
      throw new NetworkError('接口请求无效', 400, 'INVALID_REQUEST');
    }
    const envelope = JSON.stringify({
      method, path,
      body: payload == null ? '' : Buffer.from(JSON.stringify(payload)).toString('base64'),
      content_type: payload == null ? '' : 'application/json',
    });
    for (let attempt = 0; attempt < (method === 'GET' ? 2 : 1); attempt++) {
      try {
        const response = await request(`${baseOrigin}/api/edge/request`, {
          method: 'POST', body: envelope,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(envelope), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (response.status === 401 || response.status === 403) {
          response.body.destroy();
          throw new NetworkError('平台登录已失效或账号密码不正确，请重新登录', 401, 'UPSTREAM_AUTH_REQUIRED');
        }
        if (response.status < 200 || response.status >= 300) {
          response.body.destroy();
          throw new NetworkError(`上游服务返回 HTTP ${response.status}`, response.status === 429 ? 429 : 502);
        }
        const value = await readJsonBody(response);
        if (value == null) return null;
        if (value.status === 1) return value.data ?? null;
        const message = typeof value.msg === 'string' ? value.msg.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) : '上游接口返回失败';
        throw new NetworkError(message || '上游接口返回失败', 400, 'UPSTREAM_REJECTED');
      } catch (error) {
        const failure = networkMessage(error);
        if (method !== 'GET' || attempt > 0 || failure.status < 500) throw failure;
      }
    }
  }

  function getSettings() {
    return {
      proxyUrl: maskProxy(activeProxy), proxyConfigured: Boolean(activeProxy),
      proxySource: savedProxy !== undefined ? 'saved' : (environmentProxy ? 'environment' : 'direct'),
      upstreamBase: baseOrigin,
    };
  }

  function setProxy(value) {
    const next = validateProxy(value);
    const write = saving.catch(() => {}).then(async () => {
      const directory = dataDir || './data';
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = join(directory, `.settings-${randomBytes(8).toString('hex')}.tmp`);
      try {
        await writeFile(temp, `${JSON.stringify({ proxyUrl: next }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temp, settingsFile);
      } finally { await rm(temp, { force: true }); }
      savedProxy = next;
      activeProxy = next;
      return getSettings();
    });
    saving = write;
    return write;
  }

  async function diagnose() {
    const started = Date.now();
    try {
      const response = await request(`${baseOrigin}/`);
      response.body.destroy();
      return { ok: response.status >= 200 && response.status < 400, status: response.status, ms: Date.now() - started };
    } catch (error) { return { ok: false, error: networkMessage(error).message, ms: Date.now() - started }; }
  }

  function close() { closed = true; agent.destroy(); httpAgent.destroy(); httpsAgent.destroy(); }
  return { upstreamBase: baseOrigin, request, edge, getSettings, setProxy, diagnose, close };
}
