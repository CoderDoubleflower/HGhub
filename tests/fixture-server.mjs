import http from 'node:http';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createNetwork } from '../server/net.mjs';
import { access, baseURL, clipTitle, platformPassword, port, postTitle, proxyPort, proxyURL } from './fixture-config.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const mediaDirectory = join(directory, 'fixtures');
const dataDir = await mkdtemp(join(tmpdir(), 'hghub-browser-'));
const requests = [];
const proxyRequests = [];
const platformSessions = new Map();
const accounts = new Map();
let tokenSequence = 0;
let upstreamBase;
let network;
let app;

function record(list, entry) { list.push(entry); if (list.length > 1000) list.shift(); }
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function account(name) {
  if (!accounts.has(name)) accounts.set(name, { favorites: new Set(), likes: new Set() });
  return accounts.get(name);
}
function user(name) {
  return {
    id: name === 'bob' ? 12 : 11, username: name, nickname: name, avatar: '', avatar_color: '#456789',
    counts: { collect: account(name).favorites.size, like: account(name).likes.size },
  };
}
function cards() {
  return [1, 2].map((id) => ({
    id, title: id === 1 ? clipTitle : '山间 · MP4 演示',
    description: '用于验证移动网页的合成测试短片。', cover: `${upstreamBase}/cover.aes`,
    tags: ['演示'], score: 9, episode_count: 1, total_episodes: 1, duration: '5',
    hot: 120, like_count: 5, collect_count: 2, comment_count: 0,
    is_finished: true, is_original: 1, author: { id: 9, name: '演示账号', avatar: '' },
  }));
}
const paged = (items) => ({ items, pagination: { page: 1, pages: 1, size: 20, total: items.length } });

async function api(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString());
  const path = new URL(envelope.path, 'http://fixture');
  const body = envelope.body ? JSON.parse(Buffer.from(envelope.body, 'base64').toString()) : {};
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const name = platformSessions.get(token);
  record(requests, { rpc: path.pathname, method: envelope.method, account: name || null });
  const list = cards();
  let data;
  if (['/api/account/loginByPassword', '/api/account/registerByPassword'].includes(path.pathname)) {
    if (!['alice', 'bob'].includes(body.username) || body.password !== platformPassword) {
      json(res, 200, { status: 0, msg: '平台账号或密码错误' });
      return;
    }
    const next = `fixture-${body.username}-${++tokenSequence}`;
    platformSessions.set(next, body.username);
    data = { token: next, user: user(body.username) };
  } else if (path.pathname === '/api/account/logout') {
    platformSessions.delete(token);
    data = { ok: true };
  } else if (path.pathname === '/api/account/me' || /\/(collect|like|follow)$/.test(path.pathname)) {
    if (!name) { json(res, 401, { status: 0, msg: '请先登录' }); return; }
    if (path.pathname === '/api/account/me') data = user(name);
    else {
      const id = Number(path.pathname.split('/')[3]);
      const list = path.pathname.endsWith('/collect') ? account(name).favorites : account(name).likes;
      if (envelope.method === 'POST') list.add(id); else list.delete(id);
      data = { ok: true };
    }
  } else if (path.pathname.includes('/comments')) data = { ...paged([]), ep: 1 };
  else if (path.pathname === '/api/videos' || path.pathname.startsWith('/api/videos/category/')) data = paged(list);
  else if (path.pathname === '/api/search') data = { ...paged(list), keyword: path.searchParams.get('q') };
  else if (path.pathname.startsWith('/api/ranks/')) data = {
    type: 'hot', items: list.map((video, index) => ({ ...video, video_id: video.id, rank: index + 1, metric_label: '热度', metric_value: 120, metrics: {} })),
  };
  else if (path.pathname === '/api/posts') data = paged([{ id: 10, title: postTitle, cover: `${upstreamBase}/cover.aes`, tags: [], hot: 0 }]);
  else if (path.pathname === '/api/posts/10') data = {
    id: 10, title: postTitle, cover: `${upstreamBase}/cover.aes`, tags: [], hot: 0, counts: {},
    content: `<p>正常图文内容</p><svg onload="window.fixtureXss=1"></svg><iframe srcdoc="bad"></iframe><a href="java\nscript:window.fixtureXss=2">不安全链接</a><img src="${upstreamBase}/cover.aes" onerror="window.fixtureXss=3" style="position:fixed" srcset="${upstreamBase}/not-an-image 2x">`,
  };
  else if (/^\/api\/videos\/\d+\/play$/.test(path.pathname)) {
    const id = Number(path.pathname.split('/')[3]);
    data = { id, ep_num: 1, duration: 5, title: list[id - 1]?.title, video_url: `${upstreamBase}/${id === 1 ? 'master.m3u8' : 'fixture.mp4'}` };
  } else if (/^\/api\/videos\/\d+$/.test(path.pathname)) {
    const id = Number(path.pathname.split('/')[3]);
    data = {
      ...list[id - 1], episodes: [{ ep_num: 1, title: '第1集', duration: 5, status: 1 }],
      counts: { like: 5, collect: 2, comment: 0, hot: 120 },
      interaction: { liked: name ? account(name).likes.has(id) : false, collected: name ? account(name).favorites.has(id) : false },
    };
  } else { json(res, 404, { status: 0, msg: 'Unknown fixture endpoint' }); return; }
  json(res, 200, { status: 1, data });
}

const allowedFiles = new Set(['cover.aes', 'cover.png', 'fixture.mp4', 'stream.m3u8', 'key.bin', ...Array.from({ length: 5 }, (_, i) => `stream${i}.ts`)]);
const upstream = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://fixture').pathname;
    record(requests, { method: req.method, path, range: req.headers.range || null });
    if (path === '/api/edge/request') { await api(req, res); return; }
    if (path === '/') { res.end('HGhub neutral fixture'); return; }
    if (path === '/master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=360x640\nstream.m3u8\n');
      return;
    }
    const file = path.slice(1);
    if (!allowedFiles.has(file)) { res.writeHead(404); res.end(); return; }
    let bytes = await readFile(join(mediaDirectory, file === 'cover.aes' ? 'cover.png' : file));
    if (file === 'cover.aes') {
      const cipher = createCipheriv('aes-128-cbc', Buffer.from('f5d965df75336270'), Buffer.from('97b60394abc2fbe1'));
      bytes = Buffer.concat([cipher.update(bytes), cipher.final()]);
    }
    const type = file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
      : file.endsWith('.ts') ? 'video/mp2t' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      const start = Number(match?.[1]);
      const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      if (!match || start >= bytes.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); res.end(); return;
      }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    } else {
      res.setHeader('Content-Length', bytes.length);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    }
  } catch (error) {
    if (res.headersSent) res.destroy(); else json(res, 500, { error: 'Fixture request failed' });
    console.error('[fixture]', error.message);
  }
});

// This loopback-only control endpoint exists only in tests. Production never imports it.
const proxy = http.createServer(async (req, res) => {
  if (req.url === '/__fixture/state' && req.method === 'GET') {
    json(res, 200, { requests, proxyRequests }); return;
  }
  if (req.url === '/__fixture/reset' && req.method === 'POST') {
    try {
      await network.setProxy('');
      app.media.clear();
      requests.length = 0;
      proxyRequests.length = 0;
      platformSessions.clear();
      accounts.clear();
      json(res, 200, { ok: true });
    } catch { json(res, 500, { error: 'Fixture reset failed' }); }
    return;
  }
  let target;
  try { target = new URL(req.url); }
  catch { res.writeHead(400); res.end(); return; }
  if (target.origin !== upstreamBase) { res.writeHead(403); res.end(); return; }
  record(proxyRequests, { method: req.method, path: target.pathname });
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  const forward = http.request(target, { method: req.method, headers }, (reply) => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  forward.on('error', () => { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } });
  res.once('close', () => { if (!res.writableEnded) forward.destroy(); });
  req.pipe(forward);
});

function listen(server, value) {
  return new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(value, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
}
async function close(server) {
  if (!server.listening) return;
  await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await app?.close({ force: true });
  await Promise.all([close(proxy), close(upstream)]);
  await rm(dataDir, { recursive: true, force: true });
  process.exitCode = code;
}

try {
  await readFile(resolve(directory, '../dist/index.html'));
  await listen(upstream, 0);
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  network = await createNetwork({ dataDir, env: {}, upstreamBase, allowPrivateUpstream: true });
  app = await createApp({
    dataDir, env: {}, network, adminUsername: access.username, adminPassword: access.password,
    distDir: resolve(directory, '../dist'),
  });
  await listen(proxy, proxyPort);
  await listen(app.server, port);
  console.log(`[fixture] app=${baseURL} proxy=${proxyURL}; local synthetic data only`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
} catch (error) {
  console.error('[fixture]', error.message);
  await stop(1);
}
