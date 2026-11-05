import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNetwork, isPublicAddress, validateProxy } from './net.mjs';

async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'hghub-network-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function textBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function listenSocks(t, upstream, bind = '127.0.0.1') {
  const sockets = new Set();
  const requestedHosts = [];
  const socks = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let bytes = Buffer.alloc(0);
    let state = 'greeting';
    function onData(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (state === 'greeting') {
        if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return;
        bytes = bytes.subarray(2 + bytes[1]);
        state = 'connect'; socket.write(Buffer.from([5, 0]));
      }
      if (state === 'connect') {
        if (bytes.length < 5) return;
        const addressLength = bytes[3] === 3 ? bytes[4] : 4;
        const offset = bytes[3] === 3 ? 5 : 4;
        if (bytes.length < offset + addressLength + 2) return;
        const host = bytes[3] === 3 ? bytes.subarray(offset, offset + addressLength).toString() : [...bytes.subarray(offset, offset + 4)].join('.');
        const port = bytes.readUInt16BE(offset + addressLength);
        requestedHosts.push(host);
        if (host !== 'fixture.invalid' || port !== upstream.server.address().port) { socket.destroy(); return; }
        const pending = bytes.subarray(offset + addressLength + 2);
        state = 'tunnel'; socket.removeListener('data', onData);
        const destination = net.connect(port, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (pending.length) destination.write(pending);
          socket.pipe(destination); destination.pipe(socket);
        });
        sockets.add(destination); destination.on('close', () => sockets.delete(destination));
        destination.on('error', () => socket.destroy()); socket.on('close', () => destination.destroy());
      }
    }
    socket.on('data', onData);
  });
  await new Promise((resolve, reject) => {
    socks.once('error', reject);
    socks.listen(0, bind, () => { socks.off('error', reject); resolve(); });
  });
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); socks.close(resolve); }));
  return { server: socks, requestedHosts };
}

test('proxy validation accepts the supported protocols and redacts secrets in settings', async (t) => {
  for (const url of ['http://host:7890', 'https://host:8443', 'socks5://host:1080', 'socks5h://user:p%40ss@host:1080']) {
    assert.equal(validateProxy(url), url);
  }
  for (const url of ['file:///etc/passwd', 'pac+http://host/file', 'http://host/path', 'http://host/?token=1', 'http://host:99999', 'host:7890', 'http://u:p%ZZ@host']) {
    assert.throws(() => validateProxy(url), { code: 'INVALID_PROXY' });
  }
  assert.equal(validateProxy('  '), '');
  const dataDir = await temp(t);
  const network = await createNetwork({ dataDir, env: { HGHUB_PROXY: 'socks5h://private-user:private-pass@host:1080' } });
  t.after(() => network.close());
  assert.equal(network.getSettings().proxySource, 'environment');
  assert.equal(network.getSettings().proxyUrl, 'socks5h://***:***@host:1080');
  assert.ok(!JSON.stringify(network.getSettings()).includes('private-'));
  await network.setProxy('');
  assert.equal(network.getSettings().proxyConfigured, false);
  assert.equal((await stat(join(dataDir, 'settings.json'))).mode & 0o777, 0o600);
  const restarted = await createNetwork({ dataDir, env: { HGHUB_PROXY: 'http://other-host:7890' } });
  t.after(() => restarted.close());
  assert.equal(restarted.getSettings().proxySource, 'saved');
  assert.equal(restarted.getSettings().proxyUrl, '');
});

test('outbound URL policy rejects private, mapped, unexpected-domain and unsafe-protocol targets', async (t) => {
  const network = await createNetwork({ dataDir: await temp(t), env: {} });
  t.after(() => network.close());
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const target of ['http://127.0.0.1/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'file:///etc/passwd', 'https://untrusted.example/', 'https://pic.drleao.cn.evil.example/', 'https://user:pass@pic.drleao.cn/a']) {
    await assert.rejects(network.request(target, { media: true }), (error) => error.status === 400);
  }
  await assert.rejects(network.request('https://example.com/'), { code: 'TARGET_NOT_ALLOWED' });
});

test('HTTP proxy carries APIs and media; saved direct mode takes effect without restart', async (t) => {
  const received = [];
  const upstream = await listen(t, async (req, res) => {
    const body = await textBody(req);
    received.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/edge/request') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 1, data: { items: [], source: 'fixture' } }));
    } else { res.end('fixture-media'); }
  });
  const proxied = [];
  const proxy = await listen(t, (req, res) => {
    proxied.push(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const forward = http.request(req.url, { method: req.method, headers }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  const dataDir = await temp(t);
  const network = await createNetwork({ dataDir, env: { HGHUB_PROXY: proxy.url }, upstreamBase: upstream.url, allowPrivateUpstream: true });
  t.after(() => network.close());
  assert.deepEqual(await network.edge('POST', '/api/account/loginByPassword', { username: 'fixture', password: 'fixture-only' }, 'fixture-token'), { items: [], source: 'fixture' });
  const envelope = JSON.parse(received[0].body);
  assert.equal(envelope.method, 'POST');
  assert.deepEqual(JSON.parse(Buffer.from(envelope.body, 'base64').toString()), { username: 'fixture', password: 'fixture-only' });
  assert.equal(received[0].headers.authorization, 'Bearer fixture-token');
  const media = await network.request(`${upstream.url}/video.mp4`, { media: true, headers: { Range: 'bytes=0-9' } });
  assert.equal(await textBody(media.body), 'fixture-media');
  assert.equal(received[1].headers.range, 'bytes=0-9');
  assert.equal(received[1].headers.authorization, undefined);
  assert.equal(proxied.length, 2);
  await network.setProxy('');
  await network.edge('GET', '/api/videos', null);
  assert.equal(received.length, 3);
  assert.equal(proxied.length, 2);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')).proxyUrl, '');
});

test('upstream authentication is distinct from site authentication and mutations are not retried', async (t) => {
  let count = 0;
  let status = 401;
  const upstream = await listen(t, async (req, res) => {
    await textBody(req);
    count++;
    res.writeHead(status); res.end('fixture failure');
  });
  const network = await createNetwork({ dataDir: await temp(t), env: {}, upstreamBase: upstream.url, allowPrivateUpstream: true });
  t.after(() => network.close());
  await assert.rejects(network.edge('POST', '/api/account/loginByPassword', {}), { status: 401, code: 'UPSTREAM_AUTH_REQUIRED' });
  assert.equal(count, 1);
  status = 503;
  await assert.rejects(network.edge('POST', '/api/videos/1/comments', { text: 'test' }), { status: 502 });
  assert.equal(count, 2);
  await assert.rejects(network.edge('GET', '/api/videos'), { status: 502 });
  assert.equal(count, 4);
});

test('redirects are resolved relative to the final URL and revalidated before connecting', async (t) => {
  const upstream = await listen(t, (req, res) => {
    if (req.url === '/safe') { res.writeHead(302, { Location: './nested/list.m3u8' }); res.end(); }
    else if (req.url === '/bad') { res.writeHead(302, { Location: 'http://untrusted.example/secret' }); res.end(); }
    else { res.end('#EXTM3U\n'); }
  });
  const network = await createNetwork({ dataDir: await temp(t), env: {}, upstreamBase: upstream.url, allowPrivateUpstream: true });
  t.after(() => network.close());
  const response = await network.request(`${upstream.url}/safe`, { media: true });
  assert.equal(response.url, `${upstream.url}/nested/list.m3u8`);
  assert.equal(await textBody(response.body), '#EXTM3U\n');
  await assert.rejects(network.request(`${upstream.url}/bad`, { media: true }), { code: 'TARGET_NOT_ALLOWED' });
});

test('SOCKS5H resolves the destination through the proxy, including non-local DNS names', async (t) => {
  const upstream = await listen(t, (_req, res) => res.end('socks fixture'));
  const socks = await listenSocks(t, upstream);
  const network = await createNetwork({ dataDir: await temp(t), env: { HGHUB_PROXY: `socks5h://127.0.0.1:${socks.server.address().port}` }, upstreamBase: `http://fixture.invalid:${upstream.server.address().port}` });
  t.after(() => network.close());
  const response = await network.request(`${network.upstreamBase}/test`, { media: true });
  assert.equal(await textBody(response.body), 'socks fixture');
  assert.deepEqual(socks.requestedHosts, ['fixture.invalid']);
});

test('SOCKS5 applies the same private DNS destination checks as a direct request', async (t) => {
  const originalLookup = dnsPromises.lookup;
  let checkedHost = null;
  t.mock.method(dnsPromises, 'lookup', async (host, options) => {
    if (host !== 'private-dns.fixture.invalid') return originalLookup(host, options);
    checkedHost = host;
    return [{ address: '192.168.1.10', family: 4 }];
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let proxyConnections = 0;
  const proxy = await listen(t, (_req, res) => res.end());
  proxy.server.on('connection', () => { proxyConnections++; });
  const network = await createNetwork({
    dataDir: await temp(t),
    env: { HGHUB_PROXY: proxy.url.replace('http:', 'socks5:') },
    upstreamBase: 'http://private-dns.fixture.invalid',
  });
  t.after(() => network.close());
  await assert.rejects(network.request(`${network.upstreamBase}/test`, { media: true }), { code: 'UNSAFE_TARGET' });
  assert.equal(checkedHost, 'private-dns.fixture.invalid');
  assert.equal(proxyConnections, 0, 'reject a private destination before contacting the SOCKS proxy');
});

test('SOCKS5H accepts a bracketed IPv6 proxy address while retaining remote target DNS', async (t) => {
  const upstream = await listen(t, (_req, res) => res.end('ipv6 socks fixture'));
  let socks;
  try { socks = await listenSocks(t, upstream, '::1'); }
  catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
      t.skip('IPv6 loopback is unavailable on this host');
      return;
    }
    throw error;
  }
  const network = await createNetwork({
    dataDir: await temp(t),
    env: { HGHUB_PROXY: `socks5h://[::1]:${socks.server.address().port}` },
    upstreamBase: `http://fixture.invalid:${upstream.server.address().port}`,
  });
  t.after(() => network.close());
  const response = await network.request(`${network.upstreamBase}/test`, { media: true });
  assert.equal(await textBody(response.body), 'ipv6 socks fixture');
  assert.deepEqual(socks.requestedHosts, ['fixture.invalid']);
});
