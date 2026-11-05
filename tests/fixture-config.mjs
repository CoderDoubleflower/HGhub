// These credentials and ports belong only to the synthetic local test service.
export const port = Number(process.env.HGHUB_E2E_PORT || 3210);
export const noLoginPort = Number(process.env.HGHUB_E2E_NO_LOGIN_PORT || port + 1);
export const proxyPort = Number(process.env.HGHUB_E2E_PROXY_PORT || port + 2);
for (const value of [port, noLoginPort, proxyPort]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid E2E port');
}
export const baseURL = `http://127.0.0.1:${port}`;
export const noLoginURL = `http://127.0.0.1:${noLoginPort}`;
export const proxyURL = `http://127.0.0.1:${proxyPort}`;
export const access = { username: 'admin', password: 'fixture-only-password' };
export const platformPassword = 'platform-fixture-password';
export const clipTitle = '海风 · 浏览器演示';
export const postTitle = '图文演示';
