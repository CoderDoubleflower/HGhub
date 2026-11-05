import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './app.mjs';

const credentials = { username: 'admin', password: 'fixture-admin-password' };

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hghub-app-'));
  const distDir = join(dir, 'dist');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Fixture app</title>');
  await writeFile(join(distDir, 'assets', 'app-fixture.js'), 'export const fixture = true;');
  const calls = [];
  let proxy = '';
  let cacheClears = 0;
  const network = {
    upstreamBase: 'https://upstream.example',
    async edge(method, path, body, token) {
      calls.push({ method, path, body, token });
      if (path === '/api/account/loginByPassword' || path === '/api/account/registerByPassword') {
        return { token: `platform-token-${body.username}`, user: { id: body.username === 'alice' ? 1 : 2, username: body.username, password: 'private', token: 'private' } };
      }
      if (path === '/api/account/me') return { id: token?.endsWith('alice') ? 1 : 2, nickname: token?.endsWith('alice') ? 'Alice' : 'Bob' };
      return { items: [], echo: { method, path } };
    },
    getSettings: () => ({ upstreamBase: 'https://upstream.example', proxyUrl: proxy, proxyConfigured: Boolean(proxy), proxySource: proxy ? 'saved' : 'direct' }),
    setProxy: async (url) => { proxy = url; },
    diagnose: async () => ({ ok: true, status: 200, ms: 1 }),
    close() {},
  };
  const media = {
    async handle(req, res) { res.setHeader('Content-Type', 'image/png'); res.end(req.method === 'HEAD' ? undefined : 'fixture'); },
    clear() { cacheClears += 1; },
  };
  const app = await createApp({
    env: {}, dataDir: join(dir, 'data'), distDir,
    adminUsername: credentials.username, adminPassword: credentials.password,
    network, media, ...options,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close({ force: true }); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, cookie, origin = base, headers = {} } = {}) {
    return fetch(`${base}${path}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' || method === 'HEAD' ? {} : { Origin: origin, 'X-HGhub-Request': '1' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login() {
    const response = await request('/api/auth/login', { method: 'POST', body: credentials });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get('set-cookie').split(';', 1)[0];
  }
  async function rpc(command, args, cookie) {
    const response = await request(`/api/rpc/${command}`, { method: 'POST', body: args, cookie });
    return { status: response.status, body: await response.json() };
  }
  return { app, dir, distDir, base, calls, network, request, login, rpc, cacheClears: () => cacheClears };
}

test('health and login assets are public; API, settings and media require a website session', async (t) => {
  const { request } = await fixture(t);
  let response = await request('/healthz');
  assert.deepEqual(await response.json(), { ok: true });
  response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /Fixture app/);
  response = await request('/api/auth/session');
  assert.deepEqual(await response.json(), { authenticated: false, username: null, loginRequired: true });
  for (const path of ['/api/settings', '/media/img?u=https%3A%2F%2Fcdn.example%2Fcover.png']) {
    response = await request(path);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  response = await request('/api/rpc/api_feed', { method: 'POST', body: {} });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'AUTH_REQUIRED');
});

test('website login checks origin, custom header, credentials and logout invalidates the cookie', async (t) => {
  const { request, login } = await fixture(t);
  let response = await request('/api/auth/login', { method: 'POST', body: credentials, origin: 'https://other.example' });
  assert.equal(response.status, 403);
  await response.json();
  response = await request('/api/auth/login', { method: 'POST', body: credentials, headers: { 'X-HGhub-Request': '' } });
  assert.equal(response.status, 403);
  await response.json();
  response = await request('/api/auth/login', { method: 'POST', body: { ...credentials, password: 'incorrect' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_CREDENTIALS');
  const cookie = await login();
  response = await request('/api/auth/session', { cookie });
  assert.deepEqual(await response.json(), { authenticated: true, username: 'admin', loginRequired: true });
  response = await request('/api/auth/logout', { method: 'POST', cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  await response.json();
  response = await request('/api/settings', { cookie });
  assert.equal(response.status, 401);
  await response.json();
});

test('platform account tokens stay on the server and different browser cookies never share them', async (t) => {
  const { login, rpc, calls } = await fixture(t);
  const a = await login();
  const b = await login();
  const alice = await rpc('api_login', { username: 'alice', password: 'platform-fixture' }, a);
  const bob = await rpc('api_login', { username: 'bob', password: 'platform-fixture' }, b);
  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);
  assert.deepEqual(alice.body, { data: { user: { id: 1, username: 'alice' } } });
  assert.deepEqual(bob.body, { data: { user: { id: 2, username: 'bob' } } });
  assert.equal(JSON.stringify(alice.body).includes('platform-token'), false);
  assert.equal((await rpc('api_me', {}, a)).body.data.nickname, 'Alice');
  assert.equal((await rpc('api_me', {}, b)).body.data.nickname, 'Bob');
  assert.equal(calls.findLast((call) => call.path === '/api/account/me').token, 'platform-token-bob');
  await rpc('api_logout', {}, a);
  assert.equal((await rpc('app_boot', {}, a)).body.data.logged_in, false);
  assert.equal((await rpc('app_boot', {}, b)).body.data.logged_in, true);
});

test('explicit anonymous mode starts without a password and bootstraps API access while media stays public', async (t) => {
  const { request } = await fixture(t, {
    env: { HGHUB_AUTH_DISABLED: 'true' }, adminPassword: undefined,
  });
  let response = await request('/api/auth/session');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, username: null, loginRequired: false });
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  response = await request('/api/auth/session', { cookie });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { authenticated: true, username: null, loginRequired: false });

  response = await request('/api/settings');
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('set-cookie'));
  assert.equal((await response.json()).proxyConfigured, false);
  response = await request('/api/rpc/app_boot', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('set-cookie'));
  assert.equal((await response.json()).data.logged_in, false);

  response = await request('/api/auth/login', { method: 'POST', body: {}, cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { authenticated: true, username: null, loginRequired: false });
  for (const method of ['GET', 'HEAD']) {
    response = await request('/media/img?u=https%3A%2F%2Fcdn.example%2Fcover.png', { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), method === 'GET' ? 'fixture' : '');
  }
});

test('anonymous browsers keep independent platform accounts and logout only clears the current browser', async (t) => {
  const { request, rpc } = await fixture(t, { authDisabled: true, adminPassword: undefined });
  async function browserCookie() {
    const response = await request('/api/auth/session');
    assert.equal((await response.json()).authenticated, true);
    return response.headers.get('set-cookie').split(';', 1)[0];
  }
  const alice = await browserCookie();
  const bob = await browserCookie();
  assert.notEqual(alice, bob);
  assert.equal((await rpc('api_login', { username: 'alice', password: 'fixture' }, alice)).status, 200);
  assert.equal((await rpc('api_login', { username: 'bob', password: 'fixture' }, bob)).status, 200);
  assert.deepEqual((await rpc('app_boot', {}, alice)).body.data.user, { id: 1, username: 'alice' });
  assert.deepEqual((await rpc('app_boot', {}, bob)).body.data.user, { id: 2, username: 'bob' });
  assert.equal((await rpc('api_me', {}, alice)).body.data.nickname, 'Alice');
  assert.equal((await rpc('api_me', {}, bob)).body.data.nickname, 'Bob');
  await rpc('api_logout', {}, alice);
  assert.equal((await rpc('app_boot', {}, alice)).body.data.logged_in, false);
  assert.equal((await rpc('app_boot', {}, bob)).body.data.logged_in, true);

  const logout = await request('/api/auth/logout', { method: 'POST', cookie: bob });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  await logout.json();
  const fresh = await request('/api/auth/session', { cookie: bob });
  assert.deepEqual(await fresh.json(), { authenticated: true, username: null, loginRequired: false });
  const newBob = fresh.headers.get('set-cookie').split(';', 1)[0];
  assert.notEqual(newBob, bob);
  assert.equal((await rpc('app_boot', {}, newBob)).body.data.logged_in, false);
});

test('anonymous mode still rejects foreign origins and missing mutation headers before creating sessions', async (t) => {
  const { request, calls, cacheClears } = await fixture(t, { authDisabled: true, adminPassword: undefined });
  for (const [path, options] of [
    ['/api/settings', { method: 'PUT', body: { proxyUrl: 'http://proxy.example:8080' }, origin: 'https://other.example' }],
    ['/api/settings', { method: 'PUT', body: { proxyUrl: 'http://proxy.example:8080' }, headers: { 'X-HGhub-Request': '' } }],
    ['/api/rpc/api_login', { method: 'POST', body: { username: 'alice', password: 'fixture' }, origin: 'https://other.example' }],
    ['/api/settings/test', { method: 'POST', headers: { 'X-HGhub-Request': '' } }],
  ]) {
    const response = await request(path, options);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await response.json()).code, 'ORIGIN_REJECTED');
  }
  assert.equal(calls.length, 0);
  assert.equal(cacheClears(), 0);
  const response = await request('/api/settings', { method: 'PUT', body: { proxyUrl: 'http://proxy.example:8080' } });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('set-cookie'));
  assert.equal((await response.json()).proxyConfigured, true);
  assert.equal(cacheClears(), 1);
});

test('RPC validates allowlisted commands and encodes queries; mutations require a platform account', async (t) => {
  const { login, rpc, calls } = await fixture(t);
  const cookie = await login();
  let result = await rpc('api_search', { q: '中性 示例&x=1', page: 2, size: 12 }, cookie);
  assert.equal(result.status, 200);
  const query = new URL(calls.at(-1).path, 'https://upstream.example');
  assert.equal(query.searchParams.get('q'), '中性 示例&x=1');
  assert.equal(query.searchParams.get('page'), '2');
  assert.equal(query.searchParams.has('x'), false);
  for (const [command, args] of [
    ['api_video', { id: '../account/me' }], ['api_feed', { size: 10_000 }],
    ['api_category', { cate: '../account' }], ['api_like', { id: 1, ep: 1, on: 'yes' }],
  ]) {
    result = await rpc(command, args, cookie);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_INPUT');
  }
  for (const command of ['unknown_command', 'constructor', '__proto__']) {
    assert.equal((await rpc(command, {}, cookie)).status, 404);
  }
  result = await rpc('api_like', { id: 1, ep: 2, on: true }, cookie);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'UPSTREAM_AUTH_REQUIRED');
  assert.equal((await rpc('app_boot', {}, cookie)).status, 200);
  await rpc('api_login', { username: 'alice', password: 'fixture' }, cookie);
  assert.equal((await rpc('api_comment_send', { id: 3, ep: 2, text: '测试评论' }, cookie)).status, 200);
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/videos/3/comments?ep=2', body: { text: '测试评论' }, token: 'platform-token-alice' });
  await rpc('api_comment_send', { id: 3, ep: 2, text: '测试回复', replyId: 4 }, cookie);
  assert.equal(calls.at(-1).path, '/api/videos/3/comments');
  assert.deepEqual(calls.at(-1).body, { text: '测试回复', reply_id: 4 });
});

test('upstream expiry clears only the platform session and preserves website access', async (t) => {
  const { login, rpc, network, request } = await fixture(t);
  const cookie = await login();
  await rpc('api_login', { username: 'alice', password: 'fixture' }, cookie);
  network.edge = async () => { throw Object.assign(new Error('Expired'), { status: 401, code: 'UPSTREAM_AUTH_REQUIRED' }); };
  const result = await rpc('api_me', {}, cookie);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'UPSTREAM_AUTH_REQUIRED');
  assert.equal((await rpc('app_boot', {}, cookie)).body.data.logged_in, false);
  const response = await request('/api/auth/session', { cookie });
  assert.equal((await response.json()).authenticated, true);
});

test('proxy settings and connectivity diagnostics require an authenticated same-origin request', async (t) => {
  const { request, login, cacheClears } = await fixture(t);
  const cookie = await login();
  let response = await request('/api/settings', { method: 'PUT', cookie, body: { proxyUrl: 'http://proxy.example:8080' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).proxyConfigured, true);
  assert.equal(cacheClears(), 1);
  response = await request('/api/settings/test', { method: 'POST', cookie });
  assert.deepEqual(await response.json(), { ok: true, status: 200, ms: 1 });
  response = await request('/api/settings', { method: 'PUT', cookie, body: { proxyUrl: '' }, origin: 'https://other.example' });
  assert.equal(response.status, 403);
  await response.json();
  response = await request('/api/settings', { cookie });
  assert.equal((await response.json()).proxyConfigured, true);
});

test('public HTTPS origin works behind a proxy and cannot be forged with forwarding headers', async (t) => {
  const { request } = await fixture(t, { publicOrigin: 'https://web.example' });
  let response = await request('/api/auth/login', { method: 'POST', body: credentials, origin: 'https://web.example' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure$/);
  await response.json();
  response = await request('/api/auth/login', { method: 'POST', body: credentials,
    origin: 'https://evil.example', headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } });
  assert.equal(response.status, 403);
  await response.json();
});

test('static fallback does not expose dotfiles, symlinks, or turn missing assets into HTML', async (t) => {
  const { request, dir, distDir } = await fixture(t);
  await writeFile(join(dir, 'secret.txt'), 'private-data');
  await symlink(join(dir, 'secret.txt'), join(distDir, 'linked.txt'));
  for (const path of ['/.env', '/assets/missing.js', '/linked.txt', '/%2e%2e%2fsecret.txt']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('private-data'), false);
  }
  const response = await request('/profile');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Fixture app/);
});

test('JSON size and content-type limits reject malformed requests, including chunked payloads', async (t) => {
  const { request, base } = await fixture(t);
  let response = await request('/api/auth/login', { method: 'POST', body: credentials, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(response.status, 415);
  await response.json();
  response = await request('/api/auth/login', { method: 'POST', body: { username: 'a'.repeat(40_000), password: 'x' } });
  assert.equal(response.status, 413);
  await response.json();
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/auth/login`, { method: 'POST', headers: {
      Origin: base, 'X-HGhub-Request': '1', 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write('{"username":"');
    req.write('a'.repeat(40_000));
    req.end('","password":"x"}');
  });
  assert.equal(status, 413);
});
