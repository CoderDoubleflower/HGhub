import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createMediaHandler } from './media.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const pathFor = (kind, target) => `/media/${kind}?u=${encodeURIComponent(target)}`;

function upstream(body, options = {}) {
  return {
    status: 200,
    headers: {},
    url: 'https://media.example.test/source',
    body: Readable.from([Buffer.from(body)]),
    ...options,
  };
}

async function fixture(t, request, options = {}) {
  const handler = createMediaHandler({ network: { request }, ...options });
  const server = createServer((req, res) => {
    void handler.handle(req, res, new URL(req.url, 'http://localhost')).catch((error) => {
      res.destroy(error);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { handler, base, fetch: (path, options) => fetch(base + path, options) };
}

test('decrypts AES-CBC covers, serves correct HEAD metadata, and clears a bounded image cache', async (t) => {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('f5d965df75336270'), Buffer.from('97b60394abc2fbe1'));
  const encrypted = Buffer.concat([cipher.update(PNG), cipher.final()]);
  const calls = [];
  const f = await fixture(t, async (target, options) => {
    calls.push({ target, options });
    return upstream(encrypted, { url: target, headers: { 'content-type': 'application/octet-stream' } });
  }, { imageCacheMaxBytes: PNG.length + 1 });
  const first = pathFor('img', 'https://media.example.test/cover-one');
  const second = pathFor('img', 'https://media.example.test/cover-two');
  let response = await f.fetch(first);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(PNG.length));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  response = await f.fetch(first, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(PNG.length));
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(calls.length, 1, 'HEAD should use the decrypted image cache');
  await (await f.fetch(second)).arrayBuffer();
  await (await f.fetch(first)).arrayBuffer();
  assert.equal(calls.length, 3, 'the byte budget evicts the older image');
  f.handler.clear();
  await (await f.fetch(first)).arrayBuffer();
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.media, true);
  assert.equal(calls[0].options.headers['accept-encoding'], 'identity');
});

test('rewrites master variants, renditions, I-frame playlists and keys using the final redirect URL', async (t) => {
  const finalUrl = 'https://media.example.test/redirected/master.m3u8?auth=top';
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",URI="audio/list?token=a%2Bb&lang=zh"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="字幕",URI="/subs/list.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=32000,URI="iframe-list"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="//keys.example.test/key?id=1&v=2"',
    '#EXT-X-CONTENT-STEERING:SERVER-URI="https://steering.example.test/path.json"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO="audio"',
    '../rendition?quality=hd',
    '#EXT-X-STREAM-INF:BANDWIDTH=640000',
    'small.m3u8?auth=small',
    '',
  ].join('\r\n');
  const f = await fixture(t, async () => upstream(text, { url: finalUrl }));
  const response = await f.fetch(pathFor('hls', 'https://media.example.test/entry'));
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)));
  assert.ok(body.includes(`URI="${pathFor('hls', 'https://media.example.test/redirected/audio/list?token=a%2Bb&lang=zh')}"`));
  assert.ok(body.includes(`URI="${pathFor('hls', 'https://media.example.test/subs/list.m3u8')}"`));
  assert.ok(body.includes(`URI="${pathFor('hls', 'https://media.example.test/redirected/iframe-list')}"`));
  assert.ok(body.includes(`URI="${pathFor('seg', 'https://keys.example.test/key?id=1&v=2')}"`));
  assert.ok(body.includes(pathFor('hls', 'https://media.example.test/rendition?quality=hd')));
  assert.ok(body.includes(pathFor('hls', 'https://media.example.test/redirected/small.m3u8?auth=small')));
  assert.ok(!body.includes('steering.example.test'));
});

test('rewrites nested playlists served through seg, relative keys/maps, partial segments and rendition reports', async (t) => {
  const target = 'https://media.example.test/video/playlist.m3u8?auth=abc';
  const calls = [];
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin?token=k%2B1",IV=0x00000000000000000000000000000000',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXT-X-PART:DURATION=0.5,URI="part.m4s"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"',
    '#EXT-X-RENDITION-REPORT:URI="../low/playlist",LAST-MSN=32',
    '#EXTINF:6.0,',
    '#EXT-X-BYTERANGE:4096@720',
    'chunk.m4s?auth=signed%2Bvalue&n=1',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    return upstream(text, { url, headers: { 'content-type': 'application/octet-stream' } });
  });
  const response = await f.fetch(pathFor('seg', target), { headers: { Range: 'bytes=0-1' } });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(calls[0].options.headers.range, undefined, 'do not request a partial playlist');
  assert.ok(body.includes(pathFor('seg', 'https://media.example.test/key.bin?token=k%2B1')));
  assert.ok(body.includes(`URI="${pathFor('seg', 'https://media.example.test/video/init.mp4')}",BYTERANGE="720@0"`));
  assert.ok(body.includes(pathFor('seg', 'https://media.example.test/video/part.m4s')));
  assert.ok(body.includes(pathFor('seg', 'https://media.example.test/video/next.m4s')));
  assert.ok(body.includes(pathFor('hls', 'https://media.example.test/low/playlist')));
  assert.ok(body.includes('#EXT-X-BYTERANGE:4096@720\n'));
  assert.ok(body.includes(pathFor('seg', 'https://media.example.test/video/chunk.m4s?auth=signed%2Bvalue&n=1')));
});

test('refetches partial extensionless playlists, decompresses within limits, and forwards HLS reload parameters', async (t) => {
  const calls = [];
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n';
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return upstream('#E', { url, status: 206, headers: { 'content-type': 'application/x-mpegurl', 'content-range': 'bytes 0-1/100' } });
    }
    return upstream(gzipSync(text), { url, headers: { 'content-type': 'application/x-mpegurl', 'content-encoding': 'gzip' } });
  });
  const response = await f.fetch(`${pathFor('seg', 'https://media.example.test/live?auth=abc')}&_HLS_msn=32&_HLS_part=1`, {
    headers: { Range: 'bytes=0-1' },
  });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(pathFor('seg', 'https://media.example.test/segment.ts')));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.range, 'bytes=0-1');
  assert.equal(calls[1].options.headers.range, undefined);
  assert.equal(new URL(calls[1].url).searchParams.get('_HLS_msn'), '32');
  assert.equal(new URL(calls[1].url).searchParams.get('_HLS_part'), '1');
});

test('streams MP4 ranges before the upstream finishes, forwards range metadata, and strips unrelated headers', { timeout: 5000 }, async (t) => {
  const stream = new PassThrough();
  let captured;
  const f = await fixture(t, async (url, options) => {
    captured = options;
    setImmediate(() => stream.write(Buffer.from('abc')));
    return upstream('', {
      url, status: 206, body: stream,
      headers: {
        'content-type': 'video/mp4', 'content-length': '6',
        'content-range': 'bytes 10-15/100', 'accept-ranges': 'bytes', etag: '"video-v1"',
        'set-cookie': ['upstream_token=private'], 'access-control-allow-origin': '*',
      },
    });
  });
  const response = await f.fetch(pathFor('seg', 'https://media.example.test/video.mp4'), {
    headers: { Range: 'bytes=10-15', 'If-Range': '"video-v1"' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 10-15/100');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('etag'), '"video-v1"');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(captured.headers.range, 'bytes=10-15');
  assert.equal(captured.headers['if-range'], '"video-v1"');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), 'abc');
  assert.equal(stream.writableEnded, false, 'first bytes arrive without buffering the video');
  stream.end(Buffer.from('def'));
  const second = await reader.read();
  assert.equal(Buffer.from(second.value).toString(), 'def');
  assert.equal((await reader.read()).done, true);
});

test('supports HEAD and 416 responses without leaking upstream error bodies', async (t) => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push(options);
    if (options.headers.range === 'bytes=999-') {
      return upstream('<html>private upstream diagnostic</html>', {
        url, status: 416, headers: { 'content-range': 'bytes */100', 'content-type': 'text/html' },
      });
    }
    return upstream('', {
      url, headers: { 'content-type': 'video/mp4', 'content-length': '100', 'accept-ranges': 'bytes' },
    });
  });
  const path = pathFor('seg', 'https://media.example.test/movie.mp4');
  const head = await f.fetch(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '100');
  assert.equal(await head.text(), '');
  assert.equal(calls[0].method, 'HEAD');
  const unsatisfied = await f.fetch(path, { headers: { Range: 'bytes=999-' } });
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get('content-range'), 'bytes */100');
  assert.ok(!(await unsatisfied.text()).includes('private upstream diagnostic'));
});

test('aborts the upstream when the browser cancels a streaming response', { timeout: 5000 }, async (t) => {
  const stream = new PassThrough();
  let aborted;
  const canceled = new Promise((resolve) => { aborted = resolve; });
  const f = await fixture(t, async (url, options) => {
    options.signal.addEventListener('abort', () => aborted(), { once: true });
    setImmediate(() => stream.write(Buffer.alloc(1024)));
    return upstream('', { url, body: stream, headers: { 'content-type': 'video/mp4' } });
  });
  const response = await f.fetch(pathFor('seg', 'https://media.example.test/large.mp4'));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await canceled;
  assert.equal(stream.destroyed, true);
});

test('rejects invalid addresses, active-image content, oversized resources and invalid playlists', async (t) => {
  let requests = 0;
  const f = await fixture(t, async (target) => {
    requests += 1;
    if (target.includes('oversized')) return upstream(Buffer.alloc(129));
    if (target.includes('script')) return upstream('alert(1)', { headers: { 'content-type': 'text/javascript' } });
    if (target.includes('bad-uri')) return upstream('#EXTM3U\nfile:///etc/passwd\n');
    return upstream('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  }, { maxImageBytes: 128, maxPlaylistBytes: 128 });
  assert.equal((await f.fetch('/media/img')).status, 400);
  assert.equal((await f.fetch(pathFor('img', 'file:///etc/passwd'))).status, 400);
  assert.equal((await f.fetch(pathFor('seg', 'https://user:password@media.example.test/x'))).status, 400);
  assert.equal(requests, 0, 'invalid addresses never reach the network');
  assert.equal((await f.fetch(pathFor('img', 'https://media.example.test/svg'))).status, 502);
  assert.equal((await f.fetch(pathFor('hls', 'https://media.example.test/svg'))).status, 502);
  assert.equal((await f.fetch(pathFor('img', 'https://media.example.test/oversized'))).status, 502);
  assert.equal((await f.fetch(pathFor('hls', 'https://media.example.test/oversized'))).status, 502);
  assert.equal((await f.fetch(pathFor('hls', 'https://media.example.test/bad-uri'))).status, 502);
  const script = await f.fetch(pathFor('seg', 'https://media.example.test/script'));
  assert.equal(script.headers.get('content-type'), 'application/octet-stream');
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
  assert.match(script.headers.get('content-security-policy'), /sandbox/);
  await script.text();
});
