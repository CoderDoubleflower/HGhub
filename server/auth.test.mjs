import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAuth } from './auth.mjs';

const credentials = { username: 'admin', password: 'fixture-admin-password' };
const request = (cookie = '', ip = '127.0.0.1') => ({ headers: { cookie }, socket: { remoteAddress: ip } });
const cookieValue = (header) => header.split(';', 1)[0];

async function fixture(t, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hghub-auth-'));
  const options = { dataDir, adminUsername: credentials.username, adminPassword: credentials.password, ...extra };
  const auth = await createAuth(options);
  t.after(async () => { await auth.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { auth, options, dataDir };
}

test('sessions survive restart without storing the cookie or plaintext admin password', async (t) => {
  const { auth, options, dataDir } = await fixture(t, { cookieSecure: true });
  const { session, cookie } = await auth.login(request(), credentials);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /; Secure$/);
  await auth.setUpstream(session, 'fixture-platform-token', { id: 1, nickname: 'Fixture', password: 'not-public' });
  const stateFile = join(dataDir, 'sessions.json');
  const state = await readFile(stateFile, 'utf8');
  assert.equal(state.includes(credentials.password), false);
  assert.equal(state.includes(cookieValue(cookie).split('=')[1]), false);
  assert.equal(state.includes('not-public'), false);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  const restarted = await createAuth(options);
  const restored = restarted.get(request(cookieValue(cookie)));
  assert.equal(restored.upstream.token, 'fixture-platform-token');
  assert.deepEqual(restored.upstream.user, { id: 1, nickname: 'Fixture' });
  await restarted.close();
});

test('login rotates a previous cookie and browser sessions keep separate platform accounts', async (t) => {
  const { auth } = await fixture(t);
  const first = await auth.login(request(), credentials);
  const second = await auth.login(request(), credentials);
  await auth.setUpstream(first.session, 'token-a', { id: 1 });
  await auth.setUpstream(second.session, 'token-b', { id: 2 });
  assert.equal(auth.get(request(cookieValue(first.cookie))).upstream.token, 'token-a');
  assert.equal(auth.get(request(cookieValue(second.cookie))).upstream.token, 'token-b');
  const rotated = await auth.login(request(cookieValue(first.cookie)), credentials);
  assert.notEqual(rotated.cookie, first.cookie);
  assert.equal(auth.get(request(cookieValue(first.cookie))), null);
  assert.equal(auth.get(request(cookieValue(second.cookie))).upstream.token, 'token-b');
  await auth.logout(request(cookieValue(second.cookie)));
  assert.equal(auth.get(request(cookieValue(second.cookie))), null);
  await assert.rejects(() => auth.setUpstream(second.session, 'stale-token', { id: 2 }),
    (error) => error.status === 401 && error.code === 'AUTH_REQUIRED');
});

test('expired sessions and changed deployment credentials invalidate saved cookies', async (t) => {
  let time = 1_000_000;
  const { auth, options } = await fixture(t, { now: () => time, sessionTtlMs: 1000 });
  const first = await auth.login(request(), credentials);
  time += 1001;
  assert.equal(auth.get(request(cookieValue(first.cookie))), null);
  const second = await auth.login(request(), credentials);
  const changed = await createAuth({ ...options, adminPassword: 'changed-fixture-password' });
  assert.equal(changed.get(request(cookieValue(second.cookie))), null);
  await assert.rejects(() => changed.login(request(), credentials), { status: 401 });
  const current = await changed.login(request(), { ...credentials, password: 'changed-fixture-password' });
  assert.ok(changed.get(request(cookieValue(current.cookie))));
  await changed.close();
});

test('repeated bad passwords are rate limited and forwarded client IPs are not trusted', async (t) => {
  let time = 2_000_000;
  const { auth } = await fixture(t, { now: () => time });
  for (let i = 0; i < 10; i += 1) {
    const req = request();
    req.headers['x-forwarded-for'] = `203.0.113.${i}`;
    await assert.rejects(() => auth.login(req, { ...credentials, password: 'wrong-password' }), { status: 401 });
  }
  await assert.rejects(() => auth.login(request(), credentials),
    (error) => error.status === 429 && error.retryAfter > 0);
  time += 15 * 60 * 1000 + 1;
  const valid = await auth.login(request(), credentials);
  assert.ok(valid.session);
});

test('stale upstream requests cannot overwrite a more recent logout', async (t) => {
  const { auth } = await fixture(t);
  const { session } = await auth.login(request(), credentials);
  const oldRevision = session.revision;
  await auth.setUpstream(session, '', null);
  await assert.rejects(() => auth.setUpstream(session, 'late-login-token', { id: 1 }, oldRevision),
    (error) => error.status === 409 && error.code === 'SESSION_CHANGED');
  assert.equal(session.upstream.token, '');
});

test('anonymous sessions need no configured secret and preserve separate platform accounts across restart', async (t) => {
  const { auth, options, dataDir } = await fixture(t, {
    authDisabled: true, adminUsername: undefined, adminPassword: undefined,
  });
  assert.equal(auth.loginRequired, false);
  // Password protection remains the default, even if the saved state is anonymous.
  await assert.rejects(() => createAuth({ dataDir }), /HGHUB_ADMIN_PASSWORD/);
  const first = await auth.getOrCreate(request());
  const second = await auth.getOrCreate(request());
  assert.equal(first.session.username, null);
  assert.notEqual(first.cookie, second.cookie);
  assert.match(first.cookie, /HttpOnly; SameSite=Lax/);
  const reused = await auth.getOrCreate(request(cookieValue(first.cookie)));
  assert.equal(reused.session, first.session);
  assert.equal(reused.cookie, null);
  await auth.setUpstream(first.session, 'token-a', { id: 1 });
  await auth.setUpstream(second.session, 'token-b', { id: 2 });
  await auth.close();

  // Irrelevant deployment credentials do not invalidate anonymous sessions.
  const restarted = await createAuth({ ...options, adminUsername: '', adminPassword: '' });
  assert.equal(restarted.get(request(cookieValue(first.cookie))).upstream.token, 'token-a');
  assert.equal(restarted.get(request(cookieValue(second.cookie))).upstream.token, 'token-b');
  await restarted.logout(request(cookieValue(first.cookie)));
  const fresh = await restarted.getOrCreate(request(cookieValue(first.cookie)));
  assert.notEqual(fresh.cookie, first.cookie);
  assert.equal(fresh.session.upstream.token, '');
  assert.equal(restarted.get(request(cookieValue(second.cookie))).upstream.token, 'token-b');
  await restarted.close();
});

test('switching between password and anonymous modes invalidates cookies in both directions', async (t) => {
  const { auth, options } = await fixture(t);
  const passwordSession = await auth.login(request(), credentials);
  await auth.close();

  const anonymous = await createAuth({ ...options, authDisabled: true });
  assert.equal(anonymous.get(request(cookieValue(passwordSession.cookie))), null);
  const anonymousSession = await anonymous.getOrCreate(request());
  await anonymous.setUpstream(anonymousSession.session, 'private-anonymous-token', { id: 1 });
  await anonymous.close();

  const protectedAuth = await createAuth(options);
  assert.equal(protectedAuth.loginRequired, true);
  assert.equal(protectedAuth.get(request(cookieValue(passwordSession.cookie))), null);
  assert.equal(protectedAuth.get(request(cookieValue(anonymousSession.cookie))), null);
  assert.deepEqual(await protectedAuth.getOrCreate(request(cookieValue(anonymousSession.cookie))),
    { session: null, cookie: null });
  const newPasswordSession = await protectedAuth.login(request(), credentials);
  await protectedAuth.close();

  const anonymousAgain = await createAuth({ ...options, authDisabled: true });
  assert.equal(anonymousAgain.get(request(cookieValue(anonymousSession.cookie))), null);
  assert.equal(anonymousAgain.get(request(cookieValue(newPasswordSession.cookie))), null);
  await anonymousAgain.close();
});
