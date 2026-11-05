import { createDecipheriv } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';

const IMAGE_KEY = Buffer.from('f5d965df75336270', 'ascii');
const IMAGE_IV = Buffer.from('97b60394abc2fbe1', 'ascii');
const MIB = 1024 * 1024;
const HLS_TYPE = 'application/vnd.apple.mpegurl';
const HLS_RELOAD_PARAMS = ['_HLS_msn', '_HLS_part', '_HLS_skip'];
const PLAYLIST_TAGS = new Set([
  '#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-IMAGE-STREAM-INF', '#EXT-X-RENDITION-REPORT',
]);
const decompressors = {
  gzip: promisify(gunzip),
  'x-gzip': promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
};

class MediaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function imageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decryptImage(bytes) {
  let type = imageType(bytes);
  if (type) return { bytes, type };
  if (!bytes.length || bytes.length % 16 !== 0) {
    throw new MediaError(502, '封面格式不受支持或解密失败');
  }
  const decipher = createDecipheriv('aes-128-cbc', IMAGE_KEY, IMAGE_IV);
  decipher.setAutoPadding(false);
  let decoded = Buffer.concat([decipher.update(bytes), decipher.final()]);
  // The upstream also has unpadded images. Only remove valid PKCS#7 padding.
  const padding = decoded.at(-1);
  if (padding > 0 && padding <= 16 && decoded.subarray(-padding).every((value) => value === padding)) {
    decoded = decoded.subarray(0, decoded.length - padding);
  }
  type = imageType(decoded);
  if (!type) throw new MediaError(502, '封面格式不受支持或解密失败');
  return { bytes: decoded, type };
}

async function readBounded(upstream, limit) {
  const chunks = [];
  let length = 0;
  const encoding = String(header(upstream.headers, 'content-encoding') || 'identity').toLowerCase().trim();
  const declaredLength = Number(header(upstream.headers, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new MediaError(502, '媒体资源超过处理上限');
  }
  for await (const chunk of upstream.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new MediaError(502, '媒体资源超过处理上限');
    chunks.push(bytes);
  }
  const result = Buffer.concat(chunks, length);
  if (!encoding || encoding === 'identity') return result;
  if (!Object.hasOwn(decompressors, encoding)) throw new MediaError(502, '媒体压缩格式不受支持');
  try {
    return await decompressors[encoding](result, { maxOutputLength: limit });
  } catch {
    throw new MediaError(502, '媒体解压失败或资源超过处理上限');
  }
}

function isPlaylist(target, headers = {}) {
  const type = String(header(headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
  return ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(type)
    || /\.m3u8?$/i.test(new URL(target).pathname);
}

function proxyUri(uri, base, kind) {
  let target;
  try {
    target = new URL(uri, base);
  } catch {
    throw new MediaError(502, '播放列表包含无效地址');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new MediaError(502, '播放列表包含不受支持的地址');
  }
  target.hash = '';
  const route = kind || (isPlaylist(target.href) ? 'hls' : 'seg');
  return `/media/${route}?u=${encodeURIComponent(target.href)}`;
}

function rewritePlaylist(bytes, base, outputLimit) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) throw new MediaError(502, '上游返回了无效的播放列表');
  let nextIsPlaylist = false;
  const lines = text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (!line) return '';
    if (!line.startsWith('#')) {
      const result = proxyUri(line, base, nextIsPlaylist ? 'hls' : undefined);
      nextIsPlaylist = false;
      return result;
    }
    const tag = line.split(':', 1)[0];
    if (tag === '#EXT-X-STREAM-INF') nextIsPlaylist = true;
    // Steering replies contain another set of URLs. Ordinary variant selection
    // remains available without allowing a player to contact that service directly.
    if (tag === '#EXT-X-CONTENT-STEERING') return '';
    // All ordinary URI attributes (keys, maps, parts, audio/subtitle renditions,
    // I-frame playlists and rendition reports) must stay on the authenticated origin.
    return line.replace(/([:,]\s*URI=)(?:"([^"]*)"|([^,\s]+))/g, (_match, prefix, quoted, unquoted) => {
      const kind = PLAYLIST_TAGS.has(tag) ? 'hls' : 'seg';
      return `${prefix}"${proxyUri(quoted ?? unquoted, base, kind)}"`;
    });
  });
  const result = Buffer.from(`${lines.join('\n').replace(/\n+$/, '')}\n`);
  if (result.length > outputLimit) throw new MediaError(502, '播放列表超过处理上限');
  return result;
}

function commonHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendBuffer(req, res, status, bytes, type) {
  commonHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', bytes.length);
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

function safeStreamType(headers) {
  const value = String(header(headers, 'content-type') || 'application/octet-stream');
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (/^(?:video|audio)\/[a-z0-9.+_-]+$/.test(type)
    || ['application/octet-stream', 'binary/octet-stream', 'application/mp4', 'text/vtt'].includes(type)) {
    return value;
  }
  // Never serve upstream HTML, SVG or scripts as an executable same-origin document.
  return 'application/octet-stream';
}

function targetFrom(url) {
  const values = url.searchParams.getAll('u');
  if (values.length !== 1 || !values[0] || values[0].length > 8192) {
    throw new MediaError(400, '缺少有效的媒体地址');
  }
  let target;
  try {
    target = new URL(values[0]);
  } catch {
    throw new MediaError(400, '媒体地址格式错误');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new MediaError(400, '媒体地址仅支持 HTTP 或 HTTPS');
  }
  target.hash = '';
  // hls.js / Safari append these to the local playlist URL during low-latency reloads.
  for (const name of HLS_RELOAD_PARAMS) {
    if (url.searchParams.has(name)) {
      const value = url.searchParams.get(name);
      if (value.length > 128) throw new MediaError(400, '播放列表参数无效');
      target.searchParams.set(name, value);
    }
  }
  return target.href;
}

function upstreamFailure(upstream) {
  if (upstream.status === 404) return new MediaError(404, '媒体资源不存在');
  if (upstream.status === 401 || upstream.status === 403) {
    return new MediaError(403, '媒体地址已失效或无法访问，请重新打开播放页面');
  }
  return new MediaError(502, '媒体服务暂时不可用');
}

/** The application authenticates every /media request before calling this handler. */
export function createMediaHandler({
  network,
  maxImageBytes = 12 * MIB,
  maxPlaylistBytes = 2 * MIB,
  imageCacheMaxBytes = 32 * MIB,
  imageCacheMaxEntries = 128,
  imageCacheTtlMs = 10 * 60 * 1000,
} = {}) {
  const images = new Map();
  let cacheBytes = 0;
  let generation = 0;

  const removeImage = (key) => {
    const entry = images.get(key);
    if (entry) cacheBytes -= entry.bytes.length;
    images.delete(key);
  };
  const cachedImage = (key) => {
    const entry = images.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      removeImage(key);
      return null;
    }
    images.delete(key);
    images.set(key, entry);
    return entry;
  };
  const cacheImage = (key, value) => {
    if (value.bytes.length > imageCacheMaxBytes || imageCacheMaxEntries < 1) return;
    removeImage(key);
    while (images.size && (cacheBytes + value.bytes.length > imageCacheMaxBytes || images.size >= imageCacheMaxEntries)) {
      removeImage(images.keys().next().value);
    }
    images.set(key, { ...value, expires: Date.now() + imageCacheTtlMs });
    cacheBytes += value.bytes.length;
  };

  async function handle(req, res, url) {
    const controller = new AbortController();
    let activeBody;
    const abort = () => {
      controller.abort();
      activeBody?.destroy();
    };
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);

    const request = async (target, options) => {
      const result = await network.request(target, {
        ...options, media: true, signal: controller.signal,
      });
      activeBody = result.body;
      if (controller.signal.aborted) {
        activeBody.destroy();
        throw new MediaError(499, '请求已取消');
      }
      return result;
    };

    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        throw new MediaError(405, '此接口仅支持 GET 或 HEAD');
      }
      if (!['/media/img', '/media/hls', '/media/seg'].includes(url.pathname)) {
        throw new MediaError(404, '媒体接口不存在');
      }
      const target = targetFrom(url);
      const isImage = url.pathname === '/media/img';
      const knownPlaylist = url.pathname === '/media/hls' || isPlaylist(target);
      const startGeneration = generation;
      if (isImage) {
        const hit = cachedImage(target);
        if (hit) {
          sendBuffer(req, res, 200, hit.bytes, hit.type);
          return;
        }
      }

      const headers = { 'accept-encoding': 'identity' };
      if (!isImage && !knownPlaylist) {
        if (req.headers.range) {
          if (typeof req.headers.range !== 'string' || req.headers.range.length > 1024
            || !/^bytes=(?:\d+-\d*|-\d+)(?:,\s*(?:\d+-\d*|-\d+))*$/i.test(req.headers.range)) {
            throw new MediaError(400, 'Range 请求格式错误');
          }
          headers.range = req.headers.range;
        }
        if (typeof req.headers['if-range'] === 'string') headers['if-range'] = req.headers['if-range'];
      }
      let upstream = await request(target, {
        method: isImage || knownPlaylist ? 'GET' : req.method,
        headers,
      });
      const playlistResponse = !isImage && (knownPlaylist || isPlaylist(upstream.url || target, upstream.headers));
      if (playlistResponse && (upstream.status === 206 || (!knownPlaylist && req.method === 'HEAD'))) {
        // A range response cannot be rewritten; fetch the full playlist instead.
        upstream.body.destroy();
        upstream = await request(upstream.url || target, {
          method: 'GET', headers: { 'accept-encoding': 'identity' },
        });
      }

      if (upstream.status === 416 && !isImage && !playlistResponse) {
        const contentRange = header(upstream.headers, 'content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        res.setHeader('Accept-Ranges', header(upstream.headers, 'accept-ranges') || 'bytes');
        sendBuffer(req, res, 416, Buffer.from('请求的媒体范围不可用'), 'text/plain; charset=utf-8');
        return;
      }
      if (upstream.status < 200 || upstream.status >= 300) throw upstreamFailure(upstream);

      if (isImage) {
        if (upstream.status !== 200) throw upstreamFailure(upstream);
        const decoded = decryptImage(await readBounded(upstream, maxImageBytes));
        if (generation === startGeneration) cacheImage(target, decoded);
        sendBuffer(req, res, 200, decoded.bytes, decoded.type);
        return;
      }
      if (playlistResponse) {
        if (upstream.status !== 200) throw upstreamFailure(upstream);
        const bytes = await readBounded(upstream, maxPlaylistBytes);
        const rewritten = rewritePlaylist(bytes, upstream.url || target, maxPlaylistBytes * 8);
        sendBuffer(req, res, 200, rewritten, HLS_TYPE);
        return;
      }

      commonHeaders(res);
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', safeStreamType(upstream.headers));
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-encoding']) {
        const value = header(upstream.headers, name);
        if (value !== undefined) res.setHeader(name, value);
      }
      if (req.method === 'HEAD' || upstream.status === 204) {
        res.end();
        return;
      }
      // Keep memory independent of video size and propagate downstream backpressure.
      await pipeline(upstream.body, res, { signal: controller.signal });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const known = error instanceof MediaError;
      const status = known ? error.status : ([400, 403].includes(error?.status) ? error.status : 502);
      const message = known ? error.message : (status === 403 ? '此媒体地址不允许访问' : '媒体请求失败，请检查网络或代理设置');
      sendBuffer(req, res, status, Buffer.from(message), 'text/plain; charset=utf-8');
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
      if (activeBody && !activeBody.readableEnded && !activeBody.destroyed) activeBody.destroy();
    }
  }

  return {
    handle,
    clear() {
      generation += 1;
      images.clear();
      cacheBytes = 0;
    },
  };
}
