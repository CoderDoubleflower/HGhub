import { HttpError, publicUser } from './auth.mjs';

function integer(args, key, { defaultValue, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = args[key] ?? defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, `${key} 必须是有效的正整数。`, 'INVALID_INPUT');
  }
  return value;
}

function string(args, key, { max = 256, optional = false, trim = true } = {}) {
  let value = args[key];
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${key} 格式不正确。`, 'INVALID_INPUT');
  if (trim) value = value.trim();
  if ((!optional && !value) || value.length > max) {
    throw new HttpError(400, `${key} 不能为空且不能超过 ${max} 个字符。`, 'INVALID_INPUT');
  }
  return value;
}

function method(args) {
  if (typeof args.on !== 'boolean') throw new HttpError(400, 'on 必须为布尔值。', 'INVALID_INPUT');
  return args.on ? 'POST' : 'DELETE';
}

const pagination = (args) => new URLSearchParams({
  page: String(integer(args, 'page', { defaultValue: 1, max: 1_000_000 })),
  size: String(integer(args, 'size', { defaultValue: 20, max: 100 })),
}).toString();
const id = (args) => integer(args, 'id');
const episode = (args) => integer(args, 'ep', { defaultValue: 1, max: 100_000 });

/** Allowlisted counterparts to the existing Tauri commands. */
export function createRpc({ network, auth, media }) {
  async function edge(session, verb, path, body = null, required = false) {
    const token = session.upstream.token;
    const revision = session.revision;
    if (required && !token) {
      throw new HttpError(401, '请先登录平台账号。', 'UPSTREAM_AUTH_REQUIRED');
    }
    try {
      return await network.edge(verb, path, body, token || undefined);
    } catch (error) {
      if (error.code === 'UPSTREAM_AUTH_REQUIRED' || error.status === 401) {
        if (auth.isCurrent(session) && session.revision === revision) {
          await auth.setUpstream(session, '', null, revision);
        }
        throw new HttpError(401, '平台登录已失效，请重新登录平台账号。', 'UPSTREAM_AUTH_REQUIRED');
      }
      throw error;
    }
  }

  async function accountLogin(session, args, register = false) {
    const username = string(args, 'username', { max: 128 });
    const password = string(args, 'password', { max: 256, trim: false });
    const body = { username, password };
    if (register) {
      body.confirm_password = password;
      const email = string(args, 'email', { max: 254, optional: true });
      if (email) body.email = email;
    }
    const revision = session.revision;
    // Never attach an old platform token to a new platform account login.
    const data = await network.edge('POST', register
      ? '/api/account/registerByPassword' : '/api/account/loginByPassword', body);
    if (!data || typeof data.token !== 'string' || !data.token) {
      throw new HttpError(502, '平台登录响应缺少凭据。', 'UPSTREAM_ERROR');
    }
    await auth.setUpstream(session, data.token, data.user ?? null, revision);
    return { user: session.upstream.user };
  }

  const commands = {
    app_boot: async (session) => ({
      user: session.upstream.user, logged_in: Boolean(session.upstream.token), base: network.upstreamBase,
    }),
    api_login: (session, args) => accountLogin(session, args),
    api_register: (session, args) => accountLogin(session, args, true),
    api_logout: async (session) => {
      const token = session.upstream.token;
      // Clear locally first, so an unavailable upstream cannot keep this browser logged in.
      await auth.setUpstream(session, '', null);
      if (token) {
        try { await network.edge('POST', '/api/account/logout', null, token); }
        catch { /* Local logout remains successful while upstream is offline. */ }
      }
      return { ok: true };
    },
    api_me: async (session) => {
      const revision = session.revision;
      const token = session.upstream.token;
      const me = publicUser(await edge(session, 'GET', '/api/account/me', null, true));
      if (auth.isCurrent(session) && session.revision === revision) {
        await auth.setUpstream(session, token, me, revision);
      }
      return me;
    },
    api_feed: (session, args) => edge(session, 'GET', `/api/videos?${pagination(args)}`),
    api_category: (session, args) => {
      const cate = string(args, 'cate', { max: 64 });
      if (!/^[a-z0-9_-]+$/i.test(cate)) throw new HttpError(400, '分类格式不正确。', 'INVALID_INPUT');
      return edge(session, 'GET', `/api/videos/category/${encodeURIComponent(cate)}?${pagination(args)}`);
    },
    api_rank: (session, args) => {
      const kind = string(args, 'kind', { max: 16 });
      if (!['hot', 'recommend', 'potential'].includes(kind)) {
        throw new HttpError(400, '榜单类型不正确。', 'INVALID_INPUT');
      }
      return edge(session, 'GET', `/api/ranks/${kind}`);
    },
    api_search: (session, args) => {
      const q = string(args, 'q', { max: 256 });
      return edge(session, 'GET', `/api/search?${new URLSearchParams({ q })}&${pagination(args)}`);
    },
    api_posts: (session, args) => edge(session, 'GET', `/api/posts?${pagination(args)}`),
    api_post: (session, args) => edge(session, 'GET', `/api/posts/${id(args)}`),
    api_video: (session, args) => edge(session, 'GET', `/api/videos/${id(args)}`),
    api_play: (session, args) => edge(session, 'GET', `/api/videos/${id(args)}/play?ep=${episode(args)}&page_texts=0`),
    api_comments: (session, args) => edge(session, 'GET', `/api/videos/${id(args)}/comments?ep=${episode(args)}&${pagination(args)}`),
    api_post_comments: (session, args) => edge(session, 'GET', `/api/posts/${id(args)}/comments?${pagination(args)}`),
    api_comment_send: (session, args) => {
      const body = { text: string(args, 'text', { max: 5000 }) };
      let path = `/api/videos/${id(args)}/comments`;
      if (args.replyId !== undefined && args.replyId !== null) {
        body.reply_id = integer(args, 'replyId');
      } else {
        path += `?ep=${episode(args)}`;
      }
      return edge(session, 'POST', path, body, true);
    },
    api_like: (session, args) => edge(session, method(args), `/api/videos/${id(args)}/like?ep=${episode(args)}`, null, true),
    api_collect: (session, args) => edge(session, method(args), `/api/videos/${id(args)}/collect`, null, true),
    api_follow: (session, args) => edge(session, method(args), `/api/users/${integer(args, 'uid')}/follow`, null, true),
    api_post_like: (session, args) => edge(session, method(args), `/api/posts/${id(args)}/like`, null, true),
    api_post_collect: (session, args) => edge(session, method(args), `/api/posts/${id(args)}/collect`, null, true),
    cache_clear: async () => { media.clear(); return null; },
    net_diag: async () => network.diagnose(),
    // Browser diagnostics stay in the console, avoiding persistent credential/URL logs.
    debug_log: async () => null,
  };

  return async function rpc(command, args, session) {
    if (!Object.hasOwn(commands, command)) {
      throw new HttpError(404, '不支持此接口。', 'NOT_FOUND');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new HttpError(400, '请求参数必须是 JSON 对象。', 'INVALID_INPUT');
    }
    if (!auth.isCurrent(session)) throw new HttpError(401, '请先登录网页。', 'AUTH_REQUIRED');
    return commands[command](session, args);
  };
}
